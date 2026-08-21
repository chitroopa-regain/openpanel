import { z } from 'zod';

import {
  chQuery,
  compileDefinition,
  db,
  getSettingsForProject,
  loadComponentsById,
} from '@openpanel/db';
import {
  zCustomCohortDefinition,
  zCustomCohortInput,
} from '@openpanel/validation';

import { getProjectAccess } from '../access';
import { TRPCAccessError } from '../errors';
import { createTRPCRouter, protectedProcedure } from '../trpc';

/**
 * Bounded settings for any cohort evaluation triggered from the UI. A preview
 * runs against an unsaved definition, so it must never be able to become an
 * unbounded scan. On timeout we return an explicit status rather than a partial
 * count presented as exact.
 */
// NOTE: single quotes. In ClickHouse a double-quoted token is an IDENTIFIER,
// so `timeout_overflow_mode = "throw"` is a syntax error, not a setting.
const PREVIEW_SETTINGS =
  "SETTINGS max_execution_time = 30, timeout_overflow_mode = 'throw'";

/** ClickHouse: 159 TIMEOUT_EXCEEDED · 160 TOO_SLOW · 241 MEMORY_LIMIT_EXCEEDED */
const TIMEOUT_CODES = new Set([159, 160, 241]);

/**
 * True only for a genuine resource-limit failure.
 *
 * Classifies on ClickHouse's structured error CODE, never on message text.
 * Matching words was actively wrong: ClickHouse echoes the offending query in a
 * syntax error, and our preview query carries `max_execution_time` in its
 * SETTINGS clause — so a plain syntax error matched a /max_execution_time/
 * "timeout" pattern and was masked as "too large to preview", which is the exact
 * bug this classifier exists to prevent.
 */
export function isResourceLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = Number(
    (error as { code?: unknown })?.code ??
      /^Code:\s*(\d+)[.,]/.exec(message)?.[1],
  );
  return TIMEOUT_CODES.has(code);
}

async function assertAccess(userId: string, projectId: string) {
  const access = await getProjectAccess({ userId, projectId });
  if (!access) {
    throw TRPCAccessError('You do not have access to this project');
  }
}

/** Count the profiles matching a definition, and the identified universe. */
async function evaluate(
  definition: any,
  projectId: string,
): Promise<{ matched: number; universe: number; asOf: string }> {
  const { timezone } = await getSettingsForProject(projectId);
  // asOf must be "now in the PROJECT timezone", not UTC: the compiler interprets
  // it with toDateTime(asOf, tz), so a UTC string silently shifts every relative
  // window by the offset. A report evaluates its audience as of the REPORT's end
  // date, so a preview and a report can legitimately differ — the UI states the
  // asOf so that difference is visible rather than mysterious.
  const asOf = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .replace('T', ' ');
  const componentsById = await loadComponentsById(definition, projectId);
  const sets = compileDefinition(
    definition,
    projectId,
    asOf,
    timezone,
    componentsById,
  );

  const [inner, ...rest] = sets;
  const predicate = rest.length
    ? `SELECT profile_id FROM (${inner}) WHERE ${rest
        .map((s) => `profile_id IN (${s})`)
        .join(' AND ')}`
    : inner;

  const [matchedRows, universeRows] = await Promise.all([
    chQuery<{ c: number }>(
      `SELECT uniqExact(profile_id) AS c FROM (${predicate}) ${PREVIEW_SETTINGS}`,
    ),
    chQuery<{ c: number }>(
      `SELECT uniqExact(id) AS c FROM profiles WHERE project_id = {projectId:String} ${PREVIEW_SETTINGS}`.replace(
        '{projectId:String}',
        `'${projectId.replace(/'/g, "''")}'`,
      ),
    ),
  ]);

  return {
    matched: Number(matchedRows[0]?.c ?? 0),
    universe: Number(universeRows[0]?.c ?? 0),
    asOf,
  };
}

export const customCohortRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input: { projectId }, ctx }) => {
      await assertAccess(ctx.session.userId, projectId);
      return db.customCohort.findMany({
        where: { projectId },
        orderBy: { name: 'asc' },
        include: { _count: { select: { references: true } } },
      });
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input: { id }, ctx }) => {
      const existing = await db.customCohort.findUniqueOrThrow({ where: { id } });
      await assertAccess(ctx.session.userId, existing.projectId);
      return existing;
    }),

  /** Live count for an UNSAVED definition — drives the builder footer. */
  preview: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        definition: zCustomCohortDefinition,
      }),
    )
    .query(async ({ input, ctx }) => {
      await assertAccess(ctx.session.userId, input.projectId);
      try {
        return { status: 'ok' as const, ...(await evaluate(input.definition, input.projectId)) };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'preview failed';
        // Only a genuine execution-time overflow is a "too large" result.
        // Collapsing EVERY error into 'timeout' hid a plain SQL syntax error
        // behind "too large to preview" — the failure looked like a data-size
        // problem for as long as it took to read the server log.
        const isTimeout = isResourceLimitError(error);
        console.error('customCohort.preview failed', { message });
        return {
          status: isTimeout ? ('timeout' as const) : ('error' as const),
          matched: 0,
          universe: 0,
          asOf: '',
          message,
        };
      }
    }),

  create: protectedProcedure
    .input(zCustomCohortInput)
    .mutation(async ({ input, ctx }) => {
      await assertAccess(ctx.session.userId, input.projectId);
      return db.customCohort.create({
        data: {
          name: input.name,
          description: input.description,
          projectId: input.projectId,
          definition: input.definition,
          createdBy: ctx.session.userId,
        },
      });
    }),

  update: protectedProcedure
    .input(zCustomCohortInput.extend({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const existing = await db.customCohort.findUniqueOrThrow({
        where: { id: input.id },
      });
      await assertAccess(ctx.session.userId, existing.projectId);

      // version is part of every cache key — a definition edit MUST bump it or
      // reports keep serving membership computed from the old definition.
      return db.customCohort.update({
        where: { id: input.id },
        data: {
          name: input.name,
          description: input.description,
          definition: input.definition,
          version: { increment: 1 },
        },
      });
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input: { id }, ctx }) => {
      const existing = await db.customCohort.findUniqueOrThrow({
        where: { id },
        include: { references: { include: { report: true } } },
      });
      await assertAccess(ctx.session.userId, existing.projectId);

      // Fail loudly and name the reports, rather than silently dropping a
      // series the way a deleted custom event currently does.
      if (existing.references.length) {
        const names = existing.references.map((r) => r.report.name).join(', ');
        throw new Error(
          `"${existing.name}" is used by ${existing.references.length} report(s): ${names}. Remove it from those reports first.`,
        );
      }

      return db.customCohort.delete({ where: { id } });
    }),
});
