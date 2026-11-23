/**
 * "Event X was dropped" notes on report charts. Pure functions: drop periods
 * from event_meta.droppedAt + the audit log, and which periods overlap a
 * chart's date range.
 */

export type DropPeriod = {
  eventName: string;
  from: Date;
  /** null while the event is still dropped */
  to: Date | null;
  /** the undrop asked for a replay of the held window */
  replayRequested: boolean;
};

export type DropNote = {
  eventName: string;
  from: string;
  to: string | null;
  replayRequested: boolean;
};

const DROP_ACTIONS = new Set(['drop', 'drop_anyway']);
const UNDROP_ACTIONS = new Set(['undrop', 'undrop_replay']);

/**
 * Past periods come from drop → undrop pairs in the audit log; the current
 * one from event_meta.droppedAt, which is the source of truth (a drop made
 * before the audit log existed has no audit row).
 */
export function buildDropPeriods(
  droppedMetas: { name: string; droppedAt: Date | null }[],
  audit: { eventName: string; action: string; createdAt: Date }[]
): Map<string, DropPeriod[]> {
  const periods = new Map<string, DropPeriod[]>();
  const add = (period: DropPeriod) => {
    const list = periods.get(period.eventName) ?? [];
    list.push(period);
    periods.set(period.eventName, list);
  };

  const sorted = [...audit].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  );
  const open = new Map<string, Date>();
  for (const row of sorted) {
    if (DROP_ACTIONS.has(row.action)) {
      open.set(row.eventName, row.createdAt);
    } else if (UNDROP_ACTIONS.has(row.action)) {
      const from = open.get(row.eventName);
      if (from) {
        add({
          eventName: row.eventName,
          from,
          to: row.createdAt,
          replayRequested: row.action === 'undrop_replay',
        });
        open.delete(row.eventName);
      }
    }
  }

  for (const meta of droppedMetas) {
    if (meta.droppedAt) {
      add({
        eventName: meta.name,
        from: meta.droppedAt,
        to: null,
        replayRequested: false,
      });
    }
  }
  return periods;
}

/** Periods of the report's events that overlap [start, end], newest first. */
export function dropNotesForReport(
  eventNames: string[],
  periods: Map<string, DropPeriod[]>,
  window: { start: Date; end: Date }
): DropNote[] {
  const notes: DropNote[] = [];
  for (const name of new Set(eventNames)) {
    for (const period of periods.get(name) ?? []) {
      const overlaps =
        period.from <= window.end &&
        (period.to === null || period.to >= window.start);
      if (overlaps) {
        notes.push({
          eventName: period.eventName,
          from: period.from.toISOString(),
          to: period.to?.toISOString() ?? null,
          replayRequested: period.replayRequested,
        });
      }
    }
  }
  return notes.sort((a, b) => b.from.localeCompare(a.from));
}
