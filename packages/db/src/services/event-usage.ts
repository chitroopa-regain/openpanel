/**
 * Which boards, reports, cohorts and custom events use an event name. Pure
 * functions over the stored JSON so they are tested with real report configs;
 * event-management.service.ts loads the rows.
 */
import { ACTIVE_WINDOW_MS } from './event-drop-rules';

type Json = unknown;

function isRecord(value: Json): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: Json): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `*` means "any event" and is never a real event name. */
function addName(out: Set<string>, name: unknown) {
  if (typeof name === 'string' && name.length > 0 && name !== '*') {
    out.add(name);
  }
}

/**
 * A property filter on the event name itself (`name is X`) also depends on X.
 */
function addFilterNames(out: Set<string>, filters: unknown) {
  for (const filter of asArray(filters)) {
    if (!isRecord(filter) || filter.name !== 'name') {
      continue;
    }
    for (const value of asArray(filter.value)) {
      addName(out, value);
    }
  }
}

export function extractEventNamesFromCustomEvent(components: Json): string[] {
  const out = new Set<string>();
  for (const component of asArray(components)) {
    if (!isRecord(component)) {
      continue;
    }
    addName(out, component.eventName);
    addFilterNames(out, component.filters);
  }
  return [...out];
}

/** Event names a cohort definition reads, with custom events expanded. */
export function extractEventNamesFromCohortDefinition(
  definition: Json,
  customEventNames: Map<string, string[]>
): { eventNames: string[]; customEventIds: string[] } {
  const out = new Set<string>();
  const customEventIds = new Set<string>();
  if (!isRecord(definition)) {
    return { eventNames: [], customEventIds: [] };
  }
  for (const group of asArray(definition.groups)) {
    if (!isRecord(group)) {
      continue;
    }
    for (const criterion of asArray(group.criteria)) {
      if (!isRecord(criterion)) {
        continue;
      }
      const event = criterion.event;
      if (typeof event === 'string') {
        addName(out, event);
      } else if (isRecord(event) && typeof event.customEventId === 'string') {
        customEventIds.add(event.customEventId);
        for (const name of customEventNames.get(event.customEventId) ?? []) {
          out.add(name);
        }
      }
      addFilterNames(out, criterion.filters);
    }
  }
  return { eventNames: [...out], customEventIds: [...customEventIds] };
}

export type ReportUsageInput = {
  events: Json;
  breakdowns?: Json;
  options?: Json;
  cohortFilters?: Json;
  cohortBreakdown?: Json;
};

/**
 * Every event name a report needs: its series (insights, funnel steps,
 * retention start/return events and the events behind formulas, which only
 * reference series by letter), custom events expanded to their components,
 * `name` filters, Sankey include lists, and the events behind cohort filters
 * and cohort breakdowns.
 */
export function extractEventNamesFromReport(
  report: ReportUsageInput,
  lookups: {
    customEventNames: Map<string, string[]>;
    cohortEventNames: Map<string, string[]>;
  }
): string[] {
  const out = new Set<string>();

  for (const item of asArray(report.events)) {
    if (!isRecord(item)) {
      continue;
    }
    const type = item.type ?? 'event';
    if (type === 'event') {
      addName(out, item.name);
    } else if (type === 'custom_event' && typeof item.customEventId === 'string') {
      for (const name of lookups.customEventNames.get(item.customEventId) ?? []) {
        out.add(name);
      }
    }
    addFilterNames(out, item.filters);
  }

  // Breakdowns are property names; a breakdown on `name` adds no specific event.
  if (isRecord(report.options) && report.options.type === 'sankey') {
    for (const name of asArray(report.options.include)) {
      addName(out, name);
    }
  }

  const cohortIds = new Set<string>();
  for (const row of asArray(report.cohortFilters)) {
    if (isRecord(row)) {
      for (const id of asArray(row.cohortIds)) {
        if (typeof id === 'string') {
          cohortIds.add(id);
        }
      }
    }
  }
  if (isRecord(report.cohortBreakdown)) {
    for (const id of asArray(report.cohortBreakdown.cohortIds)) {
      if (typeof id === 'string') {
        cohortIds.add(id);
      }
    }
  }
  for (const id of cohortIds) {
    for (const name of lookups.cohortEventNames.get(id) ?? []) {
      out.add(name);
    }
  }

  return [...out];
}

export type UsedInItem = {
  type: 'board' | 'report';
  id: string;
  name: string;
  url: string;
  boardName: string;
  boardId: string;
  lastEditedAt: string;
  lastViewedAt: string | null;
  active: boolean;
};

export type OtherUse = {
  type: 'cohort' | 'custom_event';
  id: string;
  name: string;
};

export type EventUsage = {
  usedIn: UsedInItem[];
  otherUses: OtherUse[];
};

export type UsageSource = {
  baseUrl: string;
  organizationId: string;
  projectId: string;
  now: Date;
  dashboards: { id: string; name: string; updatedAt: Date }[];
  reports: (ReportUsageInput & {
    id: string;
    name: string;
    dashboardId: string;
    updatedAt: Date;
  })[];
  customEvents: { id: string; name: string; components: Json }[];
  cohorts: { id: string; name: string; definition: Json }[];
  /** key `${type}:${id}` → last viewed */
  views: Map<string, Date>;
};

/**
 * Active = viewed in the last 30 days. Before view tracking has recorded
 * anything for a resource, fall back to "edited in the last 30 days".
 */
export function isActive(
  lastViewedAt: Date | null,
  lastEditedAt: Date,
  now: Date
): boolean {
  const since = now.getTime() - ACTIVE_WINDOW_MS;
  if (lastViewedAt) {
    return lastViewedAt.getTime() >= since;
  }
  return lastEditedAt.getTime() >= since;
}

export function buildEventUsage(source: UsageSource): Map<string, EventUsage> {
  const usage = new Map<string, EventUsage>();
  const get = (name: string) => {
    let entry = usage.get(name);
    if (!entry) {
      entry = { usedIn: [], otherUses: [] };
      usage.set(name, entry);
    }
    return entry;
  };

  const customEventNames = new Map<string, string[]>();
  for (const ce of source.customEvents) {
    const names = extractEventNamesFromCustomEvent(ce.components);
    customEventNames.set(ce.id, names);
    for (const name of names) {
      get(name).otherUses.push({ type: 'custom_event', id: ce.id, name: ce.name });
    }
  }

  const cohortEventNames = new Map<string, string[]>();
  for (const cohort of source.cohorts) {
    const { eventNames } = extractEventNamesFromCohortDefinition(
      cohort.definition,
      customEventNames
    );
    cohortEventNames.set(cohort.id, eventNames);
    for (const name of eventNames) {
      get(name).otherUses.push({ type: 'cohort', id: cohort.id, name: cohort.name });
    }
  }

  const base = `${source.baseUrl.replace(/\/+$/, '')}/${source.organizationId}/${source.projectId}`;
  const dashboards = new Map(source.dashboards.map((d) => [d.id, d]));

  // A board was last edited when it or any of its reports was.
  const boardEdited = new Map<string, Date>();
  for (const d of source.dashboards) {
    boardEdited.set(d.id, d.updatedAt);
  }
  for (const r of source.reports) {
    const current = boardEdited.get(r.dashboardId);
    if (!current || r.updatedAt > current) {
      boardEdited.set(r.dashboardId, r.updatedAt);
    }
  }

  const boardItem = (boardId: string): UsedInItem => {
    const board = dashboards.get(boardId);
    const lastViewed = source.views.get(`dashboard:${boardId}`) ?? null;
    const lastEdited = boardEdited.get(boardId) ?? board?.updatedAt ?? source.now;
    const name = board?.name ?? '(deleted board)';
    return {
      type: 'board',
      id: boardId,
      name,
      url: `${base}/dashboards/${boardId}`,
      boardName: name,
      boardId,
      lastEditedAt: lastEdited.toISOString(),
      lastViewedAt: lastViewed?.toISOString() ?? null,
      active: isActive(lastViewed, lastEdited, source.now),
    };
  };

  // event name → board id → { board, reports }
  const byEvent = new Map<string, Map<string, UsedInItem[]>>();
  const boards = new Map<string, UsedInItem>();
  for (const report of source.reports) {
    const names = extractEventNamesFromReport(report, {
      customEventNames,
      cohortEventNames,
    });
    if (names.length === 0) {
      continue;
    }
    let board = boards.get(report.dashboardId);
    if (!board) {
      board = boardItem(report.dashboardId);
      boards.set(report.dashboardId, board);
    }
    const lastViewed = source.views.get(`report:${report.id}`) ?? null;
    const item: UsedInItem = {
      type: 'report',
      id: report.id,
      name: report.name,
      url: `${base}/reports/${report.id}`,
      boardName: board.name,
      boardId: board.id,
      lastEditedAt: report.updatedAt.toISOString(),
      lastViewedAt: lastViewed?.toISOString() ?? null,
      // Reports are mostly read on their board, so an active board makes its
      // reports active; otherwise the report's own view (or edit) decides.
      active: board.active || isActive(lastViewed, report.updatedAt, source.now),
    };
    for (const name of names) {
      let perBoard = byEvent.get(name);
      if (!perBoard) {
        perBoard = new Map();
        byEvent.set(name, perBoard);
      }
      const list = perBoard.get(board.id) ?? [];
      list.push(item);
      perBoard.set(board.id, list);
    }
  }

  for (const [name, perBoard] of byEvent) {
    const entry = get(name);
    // Active boards first, then most recently edited.
    const ordered = [...perBoard.entries()].sort(([a], [b]) => {
      const ba = boards.get(a)!;
      const bb = boards.get(b)!;
      if (ba.active !== bb.active) {
        return ba.active ? -1 : 1;
      }
      return bb.lastEditedAt.localeCompare(ba.lastEditedAt);
    });
    for (const [boardId, reports] of ordered) {
      entry.usedIn.push(boards.get(boardId)!);
      reports.sort((a, b) => b.lastEditedAt.localeCompare(a.lastEditedAt));
      entry.usedIn.push(...reports);
    }
  }

  return usage;
}

/** Boards (not reports) an event feeds, for the audit row, Slack and the red warning line. */
export function affectedBoards(usage: EventUsage | undefined) {
  return (usage?.usedIn ?? [])
    .filter((item) => item.type === 'board')
    .map((item) => ({
      id: item.id,
      name: item.name,
      url: item.url,
      active: item.active,
    }));
}

export function usageCount(usage: EventUsage | undefined): number {
  if (!usage) {
    return 0;
  }
  return (
    usage.usedIn.filter((item) => item.type === 'report').length +
    usage.otherUses.length
  );
}
