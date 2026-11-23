import { DateTime } from '@openpanel/common';
import type { IChartRange, IDateConfig } from '@openpanel/validation';
import { db } from '../prisma-client';
import { getChartStartEndDate } from './chart.service';
import {
  buildDropPeriods,
  type DropNote,
  dropNotesForReport,
} from './event-drop-notes';
import {
  extractEventNamesFromCohortDefinition,
  extractEventNamesFromCustomEvent,
  extractEventNamesFromReport,
} from './event-usage';
import { getSettingsForProject } from './organization.service';

/** Key of the notes for an unsaved report in the editor. */
export const DRAFT_REPORT_ID = 'draft';

export type DropNotesInput = {
  projectId: string;
  /** All reports of one board (one query per board), or ... */
  dashboardId?: string;
  /** ... one report (the report page). */
  reportId?: string;
  /**
   * The report editor's current (maybe unsaved) series and options; used
   * instead of the saved report so the note follows what is on screen.
   */
  draft?: {
    events: unknown;
    options?: unknown;
    cohortFilters?: unknown;
    cohortBreakdown?: unknown;
  };
  /** Board/editor date override, applied like ReportItem does. */
  range?: IChartRange | null;
  startDate?: string | null;
  endDate?: string | null;
  dateConfig?: IDateConfig | null;
};

/**
 * Drop notes per report id, in one batch: a few project-level queries, never
 * one per chart. Returns {} straight away when nothing was ever dropped.
 */
export async function getDropNotes(
  input: DropNotesInput
): Promise<Record<string, DropNote[]>> {
  if (!(input.dashboardId || input.reportId || input.draft)) {
    return {};
  }
  const [droppedMetas, audit] = await Promise.all([
    db.eventMeta.findMany({
      where: { projectId: input.projectId, droppedAt: { not: null } },
      select: { name: true, droppedAt: true },
    }),
    // The whole history: drops are rare, and a cutoff could split a
    // drop/undrop pair and lose an old gap.
    db.eventDropAudit.findMany({
      where: { projectId: input.projectId },
      select: { eventName: true, action: true, createdAt: true },
    }),
  ]);
  if (droppedMetas.length === 0 && audit.length === 0) {
    return {};
  }
  const periods = buildDropPeriods(droppedMetas, audit);

  const reportsQuery = input.draft
    ? Promise.resolve([
        {
          id: input.reportId ?? DRAFT_REPORT_ID,
          events: input.draft.events,
          options: input.draft.options ?? null,
          cohortFilters: input.draft.cohortFilters ?? null,
          cohortBreakdown: input.draft.cohortBreakdown ?? null,
          range: input.range ?? '30d',
          dateConfig: input.dateConfig ?? null,
        },
      ])
    : db.report.findMany({
      where: {
        projectId: input.projectId,
        ...(input.dashboardId
          ? { dashboardId: input.dashboardId }
          : { id: input.reportId }),
      },
      select: {
        id: true,
        events: true,
        options: true,
        cohortFilters: true,
        cohortBreakdown: true,
        range: true,
        dateConfig: true,
      },
    });
  const [reports, customEvents, cohorts, settings] = await Promise.all([
    reportsQuery,
    db.customEvent.findMany({
      where: { projectId: input.projectId },
      select: { id: true, components: true },
    }),
    db.customCohort.findMany({
      where: { projectId: input.projectId },
      select: { id: true, definition: true },
    }),
    getSettingsForProject(input.projectId),
  ]);

  const customEventNames = new Map(
    customEvents.map((ce) => [ce.id, extractEventNamesFromCustomEvent(ce.components)])
  );
  const cohortEventNames = new Map(
    cohorts.map((c) => [
      c.id,
      extractEventNamesFromCohortDefinition(c.definition, customEventNames)
        .eventNames,
    ])
  );

  // Range dates come as "yyyy-MM-dd HH:mm:ss" in the project timezone; custom
  // dates may be ISO. An unreadable date does not narrow the window.
  const parse = (value: string, fallback: Date) => {
    const zone = settings.timezone;
    const candidates = [
      DateTime.fromFormat(value, 'yyyy-MM-dd HH:mm:ss', { zone }),
      DateTime.fromISO(value, { zone }),
      DateTime.fromSQL(value, { zone }),
    ];
    const valid = candidates.find((d) => d.isValid);
    return valid ? valid.toJSDate() : fallback;
  };

  const result: Record<string, DropNote[]> = {};
  for (const report of reports) {
    const names = extractEventNamesFromReport(report, {
      customEventNames,
      cohortEventNames,
    });
    if (!names.some((name) => periods.has(name))) {
      continue;
    }
    // Same precedence as the board/report page: override, else the report's own.
    const dates = getChartStartEndDate(
      {
        range: (input.range ?? report.range) as IChartRange,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        dateConfig:
          input.dateConfig ?? (report.dateConfig as IDateConfig | null),
      },
      settings.timezone
    );
    const notes = dropNotesForReport(names, periods, {
      start: parse(dates.startDate, new Date(0)),
      end: parse(dates.endDate, new Date(8.64e15)),
    });
    if (notes.length > 0) {
      result[report.id] = notes;
    }
  }
  return result;
}
