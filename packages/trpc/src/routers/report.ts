import { z } from 'zod';

import {
  db,
  getReportById,
  getReportsByDashboardId,
  Prisma,
} from '@openpanel/db';
import { zReport } from '@openpanel/validation';

import { getProjectAccess } from '../access';
import { TRPCAccessError } from '../errors';
import { createTRPCRouter, protectedProcedure } from '../trpc';

/**
 * Mirror the report's referenced cohort ids into custom_cohort_references.
 *
 * The reference table is what powers "used by N reports" and the DB-level
 * delete protection (onDelete: Restrict), so it must track every save — a JSON
 * scan of report bodies would be both slow and race-prone.
 */
/**
 * A cohort id from ANOTHER project satisfies the foreign key (it points at
 * custom_cohorts, not at the project), so the write would commit and only fail
 * later when the filter is compiled — leaving a saved report with an unusable
 * cohort filter.
 * Ownership is therefore checked as part of the same transaction as the write.
 */
// `db` is an extended Prisma client, so Prisma.TransactionClient does not
// describe the interactive-transaction client it hands out. Derive it instead.
type CohortTx = Omit<
  typeof db,
  '$transaction' | '$connect' | '$disconnect' | '$on' | '$use' | '$extends'
>;

/** Chart types whose query path ignores a cohort breakdown. */
const COHORT_BREAKDOWN_UNSUPPORTED = new Set(['sankey', 'conversion']);

/**
 * Chart types whose query path ignores a cohort FILTER — a shorter list. Funnel
 * and retention apply it, so persisting one there is correct; only the paths
 * that would silently drop it reject it.
 */
const COHORT_FILTER_UNSUPPORTED = new Set(['sankey', 'conversion']);

/**
 * Reject rather than silently store. A report persisted with a cohort breakdown
 * on a chart type that ignores it renders an unsplit series while still
 * claiming a breakdown — wrong, and invisible.
 */
function assertCohortBreakdownSupported(report: {
  chartType: string;
  cohortFilters?: Array<{ cohortIds?: string[] }> | null;
  cohortBreakdown?: { cohortIds?: string[] } | null;
  breakdowns?: readonly unknown[] | null;
}) {
  // Property breakdown and cohort breakdown cannot coexist on ANY chart type:
  // each cohort bucket runs its own query, so a property breakdown alongside it
  // is still truncated to that bucket's own top-N values and the report means
  // something nobody asked for. Rejected rather than silently dropping one.
  if (
    (report.cohortBreakdown?.cohortIds?.length ?? 0) > 0 &&
    (report.breakdowns?.length ?? 0) > 0
  ) {
    throw new Error(
      'A cohort breakdown cannot be combined with a property breakdown. Remove one of them.',
    );
  }
  if (
    COHORT_BREAKDOWN_UNSUPPORTED.has(report.chartType) &&
    (report.cohortBreakdown?.cohortIds?.length ?? 0) > 0
  ) {
    throw new Error(
      `A cohort breakdown is not supported on ${report.chartType} reports.`,
    );
  }
  // Same reasoning for filters, on the shorter list: storing one where the query
  // path never applies it would claim a filter that does nothing.
  if (
    COHORT_FILTER_UNSUPPORTED.has(report.chartType) &&
    cohortFilterIds(report.cohortFilters).length > 0
  ) {
    throw new Error(
      `A cohort filter is not supported on ${report.chartType} reports.`,
    );
  }
}

/** Flat union of the ids referenced by the report's filter rows. */
function cohortFilterIds(
  rows: Array<{ cohortIds?: string[] }> | null | undefined,
): string[] {
  return (rows ?? []).flatMap((row) => row?.cohortIds ?? []);
}

/**
 * Every cohort a report references: the filter rows and the breakdown.
 *
 * Missing either is not cosmetic. This list drives project-ownership
 * validation, the `custom_cohort_references` rows, and delete-protection — so
 * an id that escapes it can point at another project's cohort, and its cohort
 * stays deletable while a report still depends on it.
 */
function referencedCohortIds(report: {
  cohortFilters?: Array<{ cohortIds?: string[] }> | null;
  cohortBreakdown?: { cohortIds?: string[] } | null;
}): string[] {
  return [
    ...new Set([
      ...cohortFilterIds(report.cohortFilters),
      ...(report.cohortBreakdown?.cohortIds ?? []),
    ]),
  ];
}

async function assertCohortsBelongToProject(
  tx: CohortTx,
  projectId: string,
  cohortIds: string[],
) {
  if (!cohortIds.length) return;
  const rows = await tx.customCohort.findMany({
    where: { id: { in: cohortIds } },
    select: { id: true, projectId: true, name: true },
  });
  const missing = cohortIds.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) {
    throw new Error(`Custom cohort not found: ${missing.join(', ')}`);
  }
  const foreign = rows.filter((r) => r.projectId !== projectId);
  if (foreign.length) {
    throw new Error(
      `Custom cohort does not belong to this project: ${foreign
        .map((f) => f.name)
        .join(', ')}`,
    );
  }
}

export const reportRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z.object({
        dashboardId: z.string(),
        projectId: z.string(),
      }),
    )
    .query(async ({ input: { dashboardId, projectId }, ctx }) => {
      return getReportsByDashboardId(dashboardId);
    }),
  create: protectedProcedure
    .input(
      z.object({
        report: zReport.omit({ projectId: true }),
        dashboardId: z.string(),
      }),
    )
    .mutation(async ({ input: { report, dashboardId }, ctx }) => {
      const dashboard = await db.dashboard.findUniqueOrThrow({
        where: {
          id: dashboardId,
        },
      });

      const access = await getProjectAccess({
        userId: ctx.session.userId,
        projectId: dashboard.projectId,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this project');
      }

      // Report write + reference sync must be atomic: a half-applied save would
      // leave "used by N reports" and the delete protection inconsistent.
      const created = await db.$transaction(async (tx) => {
        assertCohortBreakdownSupported(report as never);
        await assertCohortsBelongToProject(
          tx,
          dashboard.projectId,
          referencedCohortIds(report),
        );

        const row = await tx.report.create({
        data: {
          projectId: dashboard.projectId,
          dashboardId,
          name: report.name,
          events: report.series,
          interval: report.interval,
          breakdowns: report.breakdowns,
          chartType: report.chartType,
          lineType: report.lineType,
          range: report.range === 'custom' && (report as any).dateConfig
            ? 'custom'
            : report.range === 'custom'
              ? '30d'
              : report.range,
          formula: report.formula,
          previous: report.previous ?? false,
          unit: report.unit,
          metric: report.metric === 'count' ? 'sum' : report.metric,
          options: report.options,
          dateConfig: (report as any).dateConfig ?? null,
          cohortBreakdown: report.cohortBreakdown ?? Prisma.DbNull,
          cohortFilters: report.cohortFilters ?? Prisma.DbNull,
        },
        });

        const ids = referencedCohortIds(report);
        if (ids.length) {
          await tx.customCohortReference.createMany({
            data: ids.map((cohortId) => ({ cohortId, reportId: row.id })),
          });
        }
        return row;
      });

      return created;
    }),
  update: protectedProcedure
    .input(
      z.object({
        reportId: z.string(),
        report: zReport.omit({ projectId: true }),
      }),
    )
    .mutation(async ({ input: { report, reportId }, ctx }) => {
      const dbReport = await db.report.findUniqueOrThrow({
        where: {
          id: reportId,
        },
      });

      const access = await getProjectAccess({
        userId: ctx.session.userId,
        projectId: dbReport.projectId,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this project');
      }

      const updated = await db.$transaction(async (tx) => {
        assertCohortBreakdownSupported(report as never);
        const ids = referencedCohortIds(report);
        await assertCohortsBelongToProject(tx, dbReport.projectId, ids);

        const row = await tx.report.update({
        where: {
          id: reportId,
        },
        data: {
          name: report.name,
          events: report.series,
          interval: report.interval,
          breakdowns: report.breakdowns,
          chartType: report.chartType,
          lineType: report.lineType,
          range: report.range === 'custom' && (report as any).dateConfig
            ? 'custom'
            : report.range === 'custom'
              ? '30d'
              : report.range,
          formula: report.formula,
          previous: report.previous ?? false,
          unit: report.unit,
          metric: report.metric === 'count' ? 'sum' : report.metric,
          options: report.options,
          dateConfig: (report as any).dateConfig ?? null,
          cohortBreakdown: report.cohortBreakdown ?? Prisma.DbNull,
          cohortFilters: report.cohortFilters ?? Prisma.DbNull,
        },
        });

        await tx.customCohortReference.deleteMany({
          where: {
            reportId,
            ...(ids.length ? { cohortId: { notIn: ids } } : {}),
          },
        });
        for (const cohortId of ids) {
          await tx.customCohortReference.upsert({
            where: { cohortId_reportId: { cohortId, reportId } },
            create: { cohortId, reportId },
            update: {},
          });
        }
        return row;
      });

      return updated;
    }),
  delete: protectedProcedure
    .input(
      z.object({
        reportId: z.string(),
      }),
    )
    .mutation(async ({ input: { reportId }, ctx }) => {
      const report = await db.report.findUniqueOrThrow({
        where: {
          id: reportId,
        },
      });

      const access = await getProjectAccess({
        userId: ctx.session.userId,
        projectId: report.projectId,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this project');
      }

      return db.report.delete({
        where: {
          id: reportId,
        },
      });
    }),
  duplicate: protectedProcedure
    .input(
      z.object({
        reportId: z.string(),
      }),
    )
    .mutation(async ({ input: { reportId }, ctx }) => {
      const report = await db.report.findUniqueOrThrow({
        where: {
          id: reportId,
        },
        include: { layout: true },
      });

      const access = await getProjectAccess({
        userId: ctx.session.userId,
        projectId: report.projectId,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this project');
      }

      // Copy the source's layout to the new report so it sorts next to
      // the source (see getReportsByDashboardId order). The dashboard's
      // responsive repack then renders the duplicate right after source.
      //
      // Duplicating rebuilds the row field by field, so every cohort field must
      // be named here AND go through the same reference/ownership path as
      // create and update. Before this, a duplicate silently came back
      // UNFILTERED — a copy of a cohort report that quietly meant something
      // else — and its cohort had no reference row, so it was deletable while
      // the copy still depended on it.
      const cohortSource = {
        cohortFilters: report.cohortFilters as
          | Array<{ cohortIds?: string[] }>
          | null,
        cohortBreakdown: report.cohortBreakdown as {
          cohortIds?: string[];
        } | null,
      };
      const referenced = referencedCohortIds(cohortSource);

      return db.$transaction(async (tx) => {
        await assertCohortsBelongToProject(tx, report.projectId, referenced);

        const row = await tx.report.create({
        data: {
          projectId: report.projectId,
          dashboardId: report.dashboardId,
          name: `Copy of ${report.name}`,
          events: report.events!,
          interval: report.interval,
          breakdowns: report.breakdowns!,
          chartType: report.chartType,
          lineType: report.lineType,
          range: report.range,
          formula: report.formula,
          previous: report.previous,
          unit: report.unit,
          metric: report.metric,
          options: report.options,
          dateConfig: (report as any).dateConfig ?? undefined,
          cohortFilters: report.cohortFilters ?? Prisma.DbNull,
          cohortBreakdown: report.cohortBreakdown ?? Prisma.DbNull,
          ...(report.layout && {
            layout: {
              create: {
                x: report.layout.x,
                y: report.layout.y,
                w: report.layout.w,
                h: report.layout.h,
                minW: report.layout.minW ?? undefined,
                minH: report.layout.minH ?? undefined,
                maxW: report.layout.maxW ?? undefined,
                maxH: report.layout.maxH ?? undefined,
              },
            },
          }),
        },
        });

        if (referenced.length) {
          await tx.customCohortReference.createMany({
            data: referenced.map((cohortId) => ({ cohortId, reportId: row.id })),
          });
        }
        return row;
      });
    }),
  get: protectedProcedure
    .input(
      z.object({
        reportId: z.string(),
      }),
    )
    .query(async ({ input: { reportId }, ctx }) => {
      return getReportById(reportId);
    }),
  updateLayout: protectedProcedure
    .input(
      z.object({
        reportId: z.string(),
        layout: z.object({
          x: z.number(),
          y: z.number(),
          w: z.number(),
          h: z.number(),
          minW: z.number().optional(),
          minH: z.number().optional(),
          maxW: z.number().optional(),
          maxH: z.number().optional(),
        }),
      }),
    )
    .mutation(async ({ input: { reportId, layout }, ctx }) => {
      const report = await db.report.findUniqueOrThrow({
        where: {
          id: reportId,
        },
      });

      const access = await getProjectAccess({
        userId: ctx.session.userId,
        projectId: report.projectId,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this project');
      }

      // Upsert the layout (create if doesn't exist, update if it does)
      return db.reportLayout.upsert({
        where: {
          reportId: reportId,
        },
        create: {
          reportId: reportId,
          x: layout.x,
          y: layout.y,
          w: layout.w,
          h: layout.h,
          minW: layout.minW,
          minH: layout.minH,
          maxW: layout.maxW,
          maxH: layout.maxH,
        },
        update: {
          x: layout.x,
          y: layout.y,
          w: layout.w,
          h: layout.h,
          minW: layout.minW,
          minH: layout.minH,
          maxW: layout.maxW,
          maxH: layout.maxH,
        },
      });
    }),
  getLayouts: protectedProcedure
    .input(
      z.object({
        dashboardId: z.string(),
        projectId: z.string(),
      }),
    )
    .query(async ({ input: { dashboardId, projectId }, ctx }) => {
      const access = await getProjectAccess({
        userId: ctx.session.userId,
        projectId: projectId,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this project');
      }

      return db.reportLayout.findMany({
        where: {
          report: {
            dashboardId: dashboardId,
          },
        },
        include: {
          report: true,
        },
      });
    }),
  resetLayout: protectedProcedure
    .input(
      z.object({
        dashboardId: z.string(),
        projectId: z.string(),
      }),
    )
    .mutation(async ({ input: { dashboardId, projectId }, ctx }) => {
      const access = await getProjectAccess({
        userId: ctx.session.userId,
        projectId: projectId,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this project');
      }

      // Delete all layout data for reports in this dashboard
      return db.reportLayout.deleteMany({
        where: {
          report: {
            dashboardId: dashboardId,
          },
        },
      });
    }),
});
