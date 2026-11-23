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
};

export type DropNote = {
  eventName: string;
  from: string;
  to: string | null;
};

/** A note with its times written out in the project timezone, for the UI. */
export type LabeledDropNote = DropNote & {
  /** "23 Nov" (with the year when it is not the current one) */
  fromDay: string;
  /** "23 Nov, 09:10" */
  fromDayTime: string;
  /** "09:10" */
  fromTime: string;
  toDayTime: string | null;
  toTime: string | null;
};

const DROP_ACTIONS = new Set(['drop', 'drop_anyway']);
const UNDROP_ACTIONS = new Set(['undrop']);

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
      });
    }
  }
  return periods;
}

/** Current drops of the report's events, plus past drop gaps inside [start, end]; newest first. */
export function dropNotesForReport(
  eventNames: string[],
  periods: Map<string, DropPeriod[]>,
  window: { start: Date; end: Date }
): DropNote[] {
  const notes: DropNote[] = [];
  for (const name of new Set(eventNames)) {
    for (const period of periods.get(name) ?? []) {
      // A current drop is always worth knowing about; a past one only when
      // its gap falls inside the chart's range.
      const show =
        period.to === null ||
        (period.from <= window.end && period.to >= window.start);
      if (show) {
        notes.push({
          eventName: period.eventName,
          from: period.from.toISOString(),
          to: period.to?.toISOString() ?? null,
        });
      }
    }
  }
  return notes.sort((a, b) => b.from.localeCompare(a.from));
}
