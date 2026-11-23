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

/** Older drop periods than this never reach a chart's date range in practice. */
const NOTES_LOOKBACK_DAYS = 400;

export type DropNotesInput = {
  projectId: string;
  /** All reports of one board (one query per board), or ... */
  dashboardId?: string;
  /** ... one report (the report page). */
  reportId?: string;
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
  if (!input.dashboardId && !input.reportId) {
    return {};
  }
  const since = new Date(
    Date.now() - NOTES_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  );
  const [droppedMetas, audit] = await Promise.all([
    db.eventMeta.findMany({
      where: { projectId: input.projectId, droppedAt: { not: null } },
      select: { name: true, droppedAt: true },
    }),
    db.eventDropAudit.findMany({
      where: { projectId: input.projectId, createdAt: { gte: since } },
      select: { eventName: true, action: true, createdAt: true },
    }),
  ]);
  if (droppedMetas.length === 0 && audit.length === 0) {
    return {};
  }
  const periods = buildDropPeriods(droppedMetas, audit);

  const [reports, customEvents, cohorts, settings] = await Promise.all([
    db.report.findMany({
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
    }),
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
      start: parse(dates.startDate, since),
      end: parse(dates.endDate, new Date(8.64e15)),
    });
    if (notes.length > 0) {
      result[report.id] = notes;
    }
  }
  return result;
}
