/**
 * Events settings page and the /manage REST API share these functions: one
 * code path for listing, dropping and undropping event names.
 *
 * Drop = add the name to the Redis set op:dropped:<projectId> (Jitsu ingest
 * reads it and stops storing new events of that name; they are not kept) +
 * stamp event_meta.droppedAt. ClickHouse history is never deleted. Undrop
 * only lets new events in again.
 */
import { DateTime } from '@openpanel/common';
import sqlstring from 'sqlstring';
import { ch, TABLE_NAMES } from '../clickhouse/client';
import { logger } from '../logger';
import { db } from '../prisma-client';
import {
  addDroppedEvent,
  projectDropLockKey,
  removeDroppedEvent,
} from './drop-events.service';
import {
  assertCanDrop,
  assertCanUndrop,
  EventDropError,
  type EventDropSource,
  HIGH_VOLUME_PCT,
  isProtectedEventName,
} from './event-drop-rules';
import { getEventMetasCached } from './event.service';
import { getSettingsForProject } from './organization.service';
import {
  affectedBoards,
  buildEventUsage,
  type EventUsage,
  type OtherUse,
  type UsedInItem,
  usageCount,
} from './event-usage';

export const EVENT_NAME_DAILY_TABLE = 'event_name_daily';
/** One row per day the regainapp rollup finished (pass >= 1, running = 0). */
export const EVENT_NAME_ROLLUP_DAYS_TABLE = 'event_name_rollup_days';
/** event_name_daily.day is a calendar day in this timezone (the rollup's). */
export const VOLUME_TIMEZONE = 'Asia/Kolkata';
const TREND_DAYS = 30;
const VIEW_THROTTLE_MS = 10 * 60 * 1000;
const SLACK_TIMEOUT_MS = 5000;
const SLACK_PREVIEW_BOARDS = 5;

export type ManagedEventStatus = 'active' | 'dropped' | 'protected';
export const MANAGED_EVENT_FILTERS = [
  'all',
  'unused',
  'used',
  'dropped',
  'protected',
  'unused_high',
  'kept',
] as const;
export type ManagedEventFilter = (typeof MANAGED_EVENT_FILTERS)[number];

export type ManagedEvent = {
  name: string;
  /** null when openpanel.event_name_daily is missing or failed */
  volume1d: number | null;
  volume7d: number | null;
  volume30d: number | null;
  pctOfProject: number | null;
  lastSeen: string | null;
  /** Daily counts, oldest first, ending on the volume day. */
  trend30d: number[] | null;
  usedIn: UsedInItem[];
  otherUses: OtherUse[];
  usageCount: number;
  status: ManagedEventStatus;
  droppedAt: string | null;
  /** Dropped events: who dropped it and why (latest drop in the audit log). */
  dropInfo: {
    source: EventDropSource;
    requestedBy: string | null;
    reason: string | null;
  } | null;
  /** Dropped events: 1d volume of the IST day before the drop, if the rollup has it. */
  volumeBeforeDrop: number | null;
  /**
   * Marked Keep: used outside OpenPanel (a skill, raw SQL, a script), which
   * "Used in" cannot see. Kept events are not counted as "not used".
   */
  keepInfo: {
    note: string;
    source: EventDropSource;
    requestedBy: string | null;
    keptAt: string;
  } | null;
};

/** Keep notes are short labels, e.g. "read by the review-lookup skill". */
export const KEEP_NOTE_MAX_LENGTH = 200;

export type ManagedEventsResult = {
  events: ManagedEvent[];
  volumeAvailable: boolean;
  /**
   * YYYY-MM-DD (IST) of the "1d" column: the newest day the rollup finished,
   * or today when no day is finished yet (then volumeIsPartial).
   */
  volumeDay: string | null;
  /** No finished day yet: 1d is today so far, 7d/30d are null. */
  volumeIsPartial: boolean;
  /** Partial only: when the oldest of today's counts was computed (ISO). */
  volumeAsOf: string | null;
  /** Project timezone, for "Dropped on". */
  timezone: string;
  /** OPENPANEL_SLACK_WEBHOOK_URL is set: drops and undrops are posted to Slack. */
  slackConfigured: boolean;
  totals: {
    events: number;
    volume1d: number | null;
    unusedEvents: number;
    unusedVolume1d: number | null;
  };
  counts: Record<ManagedEventFilter, number>;
};

type VolumeRow = {
  volume1d: number;
  volume7d: number | null;
  volume30d: number | null;
  lastSeen: string | null;
  trend30d: number[];
};

function dashboardBaseUrl() {
  return (
    process.env.DASHBOARD_URL ||
    process.env.NEXT_PUBLIC_DASHBOARD_URL ||
    ''
  ).replace(/\/+$/, '');
}

function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/** Today's date (YYYY-MM-DD) in the rollup's timezone. */
export function volumeToday(now: Date = new Date()): string {
  return DateTime.fromJSDate(now).setZone(VOLUME_TIMEZONE).toISODate()!;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const UNKNOWN_TABLE = /UNKNOWN_TABLE|Code: 60\b/;

/**
 * Finished rollup days in the 30-day window ending on the newest finished
 * day before today, newest first; [] when none is finished yet. Only a missing rollup_days table (an older
 * rollup) gives null: then every day up to yesterday counts. Any other
 * error is thrown, so the page shows "—" rather than unfinished numbers.
 */
async function getFinishedVolumeDays(today: string): Promise<string[] | null> {
  const t = sqlstring.escape(today);
  try {
    const res = await ch.query({
      // The newest finished day (no lower bound), then every finished day in
      // the 30-day window that ends on it. No finished day: NULL bounds, no rows.
      query: `
        WITH (
          SELECT maxOrNull(day)
          FROM ${EVENT_NAME_ROLLUP_DAYS_TABLE} FINAL
          WHERE pass >= 1 AND running = 0 AND day < toDate(${t})
        ) AS anchor
        SELECT toString(day) AS day_iso
        FROM ${EVENT_NAME_ROLLUP_DAYS_TABLE} FINAL
        WHERE pass >= 1 AND running = 0
          AND day <= anchor AND day > anchor - ${TREND_DAYS}
        ORDER BY day DESC`,
      format: 'JSONEachRow',
    });
    const rows = await res.json<{ day_iso: string }>();
    return rows.map((row) => row.day_iso).filter((day) => ISO_DAY.test(day));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (UNKNOWN_TABLE.test(message)) {
      logger.warn('event_name_rollup_days missing; volume 1d = yesterday', { error: message });
      return null;
    }
    throw error;
  }
}

/**
 * Reads the rollup built by the regainapp job, in IST days (its timezone; the
 * ClickHouse server's today() is UTC, so it is never used). 1d/7d/30d end on
 * the newest finished day; before any day is finished, 1d is today so far and
 * 7d/30d are null. FINAL keeps only the newest rewrite of each row. A missing
 * table (or any ClickHouse error) gives `available: false` and the page shows "—".
 */
export async function getEventVolumes(
  projectId: string,
  now: Date = new Date()
): Promise<{
  available: boolean;
  volumeDay: string | null;
  partial: boolean;
  asOf: string | null;
  rows: Map<string, VolumeRow>;
}> {
  const today = volumeToday(now);
  try {
    const finishedDays = await getFinishedVolumeDays(today);
    // null: no rollup_days table, count every day up to yesterday.
    const anchor = finishedDays === null ? addDays(today, -1) : (finishedDays[0] ?? today);
    const partial = finishedDays !== null && finishedDays.length === 0;
    const a = sqlstring.escape(anchor);
    // 7d/30d sum finished days only (a day being recounted is left out).
    const finishedOnly =
      finishedDays === null || partial
        ? ''
        : ` AND day IN (${finishedDays.map((day) => `toDate(${sqlstring.escape(day)})`).join(', ')})`;
    const query = `
    SELECT
      name,
      sumIf(e, day = toDate(${a})) AS v1,
      sumIf(e, day > toDate(${a}) - 7 AND day <= toDate(${a})${finishedOnly}) AS v7,
      sumIf(e, day > toDate(${a}) - 30 AND day <= toDate(${a})${finishedOnly}) AS v30,
      max(ls) AS last_seen_ts,
      maxIf(ca, day = toDate(${a})) AS computed_ms,
      groupArray((toString(day), e)) AS daily
    FROM (
      SELECT name, day, toFloat64(sum(events)) AS e,
        toUnixTimestamp(max(last_seen)) AS ls,
        toUnixTimestamp64Milli(max(computed_at)) AS ca
      FROM ${EVENT_NAME_DAILY_TABLE} FINAL
      WHERE project_id = ${sqlstring.escape(projectId)}
        -- Up to today, so "Last seen" includes days after the anchor; the
        -- 1d/7d/30d sums stop at the anchor.
        AND day > toDate(${a}) - ${TREND_DAYS} AND day <= toDate(${sqlstring.escape(today)})
      GROUP BY name, day
    )
    GROUP BY name`;
    const res = await ch.query({ query, format: 'JSONEachRow' });
    const data = await res.json<{
      name: string;
      v1: number;
      v7: number;
      v30: number;
      last_seen_ts: number | string;
      computed_ms: number | string;
      daily: [string, number][];
    }>();
    const rows = new Map<string, VolumeRow>();
    // Oldest computation among today's counts: the tooltip never claims a
    // count is fresher than it is.
    let asOfMs = Number.POSITIVE_INFINITY;
    for (const row of data) {
      const byDay = new Map(row.daily.map(([day, e]) => [day, Number(e)]));
      const trend30d: number[] = [];
      for (let i = TREND_DAYS - 1; i >= 0; i--) {
        trend30d.push(byDay.get(addDays(anchor, -i)) ?? 0);
      }
      const lastSeenTs = Number(row.last_seen_ts);
      const computedMs = Number(row.computed_ms) || 0;
      if (computedMs > 0) {
        asOfMs = Math.min(asOfMs, computedMs);
      }
      rows.set(row.name, {
        volume1d: Number(row.v1),
        // 7d/30d count finished days only: none yet while partial.
        volume7d: partial ? null : Number(row.v7),
        volume30d: partial ? null : Number(row.v30),
        lastSeen: lastSeenTs > 0 ? new Date(lastSeenTs * 1000).toISOString() : null,
        trend30d,
      });
    }
    return {
      available: true,
      volumeDay: anchor,
      partial,
      asOf:
        partial && Number.isFinite(asOfMs) ? new Date(asOfMs).toISOString() : null,
      rows,
    };
  } catch (error) {
    logger.warn('event_name_daily unavailable; Events page shows no volume', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { available: false, volumeDay: null, partial: false, asOf: null, rows: new Map() };
  }
}

async function getKnownEventNames(projectId: string): Promise<string[]> {
  try {
    const res = await ch.query({
      query: `SELECT DISTINCT name FROM ${TABLE_NAMES.event_names_mv} WHERE project_id = ${sqlstring.escape(projectId)}`,
      format: 'JSONEachRow',
    });
    const rows = await res.json<{ name: string }>();
    return rows.map((row) => row.name);
  } catch (error) {
    logger.warn('Could not read event names for the Events page', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

async function getProjectOrThrow(projectId: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, organizationId: true },
  });
  if (!project) {
    throw new EventDropError('NOT_FOUND', `Project ${projectId} not found`);
  }
  return project;
}

/** Usage of every event name in a project, from Postgres report/board JSON. */
export async function getEventUsageForProject(project: {
  id: string;
  organizationId: string;
}): Promise<Map<string, EventUsage>> {
  const [dashboards, reports, customEvents, cohorts, views] = await Promise.all([
    db.dashboard.findMany({
      where: { projectId: project.id },
      select: { id: true, name: true, updatedAt: true },
    }),
    db.report.findMany({
      where: { projectId: project.id },
      select: {
        id: true,
        name: true,
        dashboardId: true,
        updatedAt: true,
        events: true,
        breakdowns: true,
        options: true,
        cohortFilters: true,
        cohortBreakdown: true,
      },
    }),
    db.customEvent.findMany({
      where: { projectId: project.id },
      select: { id: true, name: true, components: true },
    }),
    db.customCohort.findMany({
      where: { projectId: project.id },
      select: { id: true, name: true, definition: true },
    }),
    db.resourceView.findMany({
      where: { projectId: project.id },
      select: { resourceType: true, resourceId: true, lastViewedAt: true },
    }),
  ]);

  return buildEventUsage({
    baseUrl: dashboardBaseUrl(),
    organizationId: project.organizationId,
    projectId: project.id,
    now: new Date(),
    dashboards,
    reports,
    customEvents,
    cohorts,
    views: new Map(
      views.map((v) => [`${v.resourceType}:${v.resourceId}`, v.lastViewedAt])
    ),
  });
}

function matchesFilter(event: ManagedEvent, filter: ManagedEventFilter) {
  switch (filter) {
    case 'all':
      return true;
    case 'dropped':
      return event.status === 'dropped';
    case 'protected':
      return event.status === 'protected';
    case 'used':
      return event.status === 'active' && event.usageCount > 0;
    case 'unused':
      return (
        event.status === 'active' && event.usageCount === 0 && !event.keepInfo
      );
    case 'unused_high':
      return (
        event.status === 'active' &&
        event.usageCount === 0 &&
        !event.keepInfo &&
        (event.pctOfProject ?? 0) >= HIGH_VOLUME_PCT
      );
    case 'kept':
      return event.status !== 'dropped' && Boolean(event.keepInfo);
  }
}

export function isSlackConfigured(): boolean {
  return Boolean(process.env.OPENPANEL_SLACK_WEBHOOK_URL);
}

/**
 * 1d volume of the IST day before each drop (the last full day the event was
 * stored), in one query. Missing table or row: no entry.
 */
async function getVolumesBeforeDrop(
  projectId: string,
  dropped: Map<string, Date>
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (dropped.size === 0) {
    return result;
  }
  const dayBefore = new Map<string, string>();
  for (const [name, at] of dropped) {
    dayBefore.set(name, addDays(volumeToday(at), -1));
  }
  const pairs = [...dayBefore]
    .map(([name, day]) => `(${sqlstring.escape(name)}, toDate(${sqlstring.escape(day)}))`)
    .join(', ');
  try {
    const res = await ch.query({
      query: `
        SELECT name, toString(day) AS day_iso, toFloat64(sum(events)) AS e
        FROM ${EVENT_NAME_DAILY_TABLE} FINAL
        WHERE project_id = ${sqlstring.escape(projectId)} AND (name, day) IN (${pairs})
        GROUP BY name, day`,
      format: 'JSONEachRow',
    });
    for (const row of await res.json<{ name: string; day_iso: string; e: number }>()) {
      if (dayBefore.get(row.name) === row.day_iso) {
        result.set(row.name, Number(row.e));
      }
    }
  } catch (error) {
    logger.warn('Could not read volume before drop', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return result;
}

/** Latest drop audit row per event name. */
async function getLatestDrops(projectId: string, names: string[]) {
  if (names.length === 0) {
    return new Map<string, NonNullable<ManagedEvent['dropInfo']>>();
  }
  const rows = await db.eventDropAudit.findMany({
    where: { projectId, eventName: { in: names }, action: { in: ['drop', 'drop_anyway'] } },
    orderBy: { createdAt: 'desc' },
    distinct: ['eventName'],
    select: { eventName: true, source: true, requestedBy: true, reason: true },
  });
  return new Map(
    rows.map((row) => [
      row.eventName,
      {
        source: row.source as EventDropSource,
        requestedBy: row.requestedBy,
        reason: row.reason,
      },
    ])
  );
}

/** Latest keep/unkeep per event; an event is kept when that row is a keep. */
async function getKeeps(projectId: string) {
  const rows = await db.eventDropAudit.findMany({
    where: { projectId, action: { in: ['keep', 'unkeep'] } },
    orderBy: { createdAt: 'desc' },
    distinct: ['eventName'],
    select: {
      eventName: true,
      action: true,
      reason: true,
      source: true,
      requestedBy: true,
      createdAt: true,
    },
  });
  const keeps = new Map<string, NonNullable<ManagedEvent['keepInfo']>>();
  for (const row of rows) {
    if (row.action === 'keep') {
      keeps.set(row.eventName, {
        note: row.reason ?? '',
        source: row.source as EventDropSource,
        requestedBy: row.requestedBy,
        keptAt: row.createdAt.toISOString(),
      });
    }
  }
  return keeps;
}

export async function listManagedEvents({
  projectId,
  filter = 'all',
  q,
}: {
  projectId: string;
  filter?: ManagedEventFilter;
  q?: string;
}): Promise<ManagedEventsResult> {
  const project = await getProjectOrThrow(projectId);
  const [volumes, knownNames, metas, usage] = await Promise.all([
    getEventVolumes(projectId),
    getKnownEventNames(projectId),
    db.eventMeta.findMany({
      where: { projectId },
      select: { name: true, droppedAt: true },
    }),
    getEventUsageForProject(project),
  ]);

  const droppedAt = new Map(
    metas.filter((m) => m.droppedAt).map((m) => [m.name, m.droppedAt!])
  );
  const [latestDrops, beforeDrop, settings, keeps] = await Promise.all([
    getLatestDrops(projectId, [...droppedAt.keys()]),
    volumes.available
      ? getVolumesBeforeDrop(projectId, droppedAt)
      : Promise.resolve(new Map<string, number>()),
    getSettingsForProject(projectId),
    getKeeps(projectId),
  ]);
  const names = new Set<string>([
    ...knownNames,
    ...volumes.rows.keys(),
    ...droppedAt.keys(),
  ]);
  names.delete('*');

  let projectVolume1d = 0;
  for (const row of volumes.rows.values()) {
    projectVolume1d += row.volume1d;
  }

  const all: ManagedEvent[] = [];
  for (const name of names) {
    const volume = volumes.rows.get(name);
    const eventUsage = usage.get(name);
    const dropped = droppedAt.get(name) ?? null;
    const status: ManagedEventStatus = dropped
      ? 'dropped'
      : isProtectedEventName(name)
        ? 'protected'
        : 'active';
    const volume1d = volumes.available ? (volume?.volume1d ?? 0) : null;
    all.push({
      name,
      volume1d,
      volume7d:
        volumes.available && !volumes.partial ? (volume?.volume7d ?? 0) : null,
      volume30d:
        volumes.available && !volumes.partial ? (volume?.volume30d ?? 0) : null,
      pctOfProject:
        volume1d === null || projectVolume1d === 0
          ? null
          : (100 * volume1d) / projectVolume1d,
      lastSeen: volume?.lastSeen ?? null,
      trend30d: volumes.available
        ? (volume?.trend30d ?? new Array(TREND_DAYS).fill(0))
        : null,
      usedIn: eventUsage?.usedIn ?? [],
      otherUses: eventUsage?.otherUses ?? [],
      usageCount: usageCount(eventUsage),
      status,
      droppedAt: dropped?.toISOString() ?? null,
      dropInfo: dropped ? (latestDrops.get(name) ?? null) : null,
      volumeBeforeDrop: dropped ? (beforeDrop.get(name) ?? null) : null,
      keepInfo: keeps.get(name) ?? null,
    });
  }

  all.sort(
    (a, b) =>
      (b.volume1d ?? -1) - (a.volume1d ?? -1) || a.name.localeCompare(b.name)
  );

  const counts = Object.fromEntries(
    MANAGED_EVENT_FILTERS.map((f) => [f, all.filter((e) => matchesFilter(e, f)).length])
  ) as Record<ManagedEventFilter, number>;
  const unused = all.filter((e) => matchesFilter(e, 'unused'));

  const needle = q?.trim().toLowerCase();
  const events = all.filter(
    (e) =>
      matchesFilter(e, filter) &&
      (!needle || e.name.toLowerCase().includes(needle))
  );

  return {
    events,
    volumeAvailable: volumes.available,
    volumeDay: volumes.volumeDay,
    volumeIsPartial: volumes.partial,
    volumeAsOf: volumes.asOf,
    timezone: settings.timezone,
    slackConfigured: isSlackConfigured(),
    totals: {
      events: all.length,
      volume1d: volumes.available ? projectVolume1d : null,
      unusedEvents: unused.length,
      unusedVolume1d: volumes.available
        ? unused.reduce((sum, e) => sum + (e.volume1d ?? 0), 0)
        : null,
    },
    counts,
  };
}

/** Usage of one event, for the drop guard. */
async function getUsageOfEvent(
  project: { id: string; organizationId: string },
  name: string
) {
  const usage = await getEventUsageForProject(project);
  return usage.get(name);
}

export type EventActionInput = {
  projectId: string;
  name: string;
  confirmName: string;
  source: EventDropSource;
  requestedBy?: string | null;
  chatUrl?: string | null;
};

function assertActor(input: EventActionInput) {
  if (input.source !== 'UI' && input.source !== 'Agent') {
    throw new EventDropError('INVALID_INPUT', 'source must be "UI" or "Agent"');
  }
  if (input.source === 'Agent' && !input.requestedBy?.trim()) {
    throw new EventDropError(
      'INVALID_INPUT',
      'requestedBy is required when source is "Agent"'
    );
  }
  if (input.chatUrl && !/^https?:\/\//i.test(input.chatUrl)) {
    throw new EventDropError('INVALID_INPUT', 'chatUrl must be an http(s) URL');
  }
}

const ACTION_TX_TIMEOUT_MS = 20 * 1000;

/** The client Prisma hands to an interactive transaction. */
type Tx = Omit<
  typeof db,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * After a failed action, put Redis back to what Postgres committed (the
 * source of truth), instead of blindly undoing our own write: another
 * request may have changed the state in between.
 */
async function reconcileRedis(projectId: string, name: string) {
  try {
    // Same advisory lock as the actions, so a concurrent drop/undrop cannot
    // commit between our read and our Redis write.
    await db.$transaction(
      async (tx) => {
        await lockEvent(tx, projectId, name);
        const meta = await tx.eventMeta.findUnique({
          where: { name_projectId: { name, projectId } },
          select: { droppedAt: true },
        });
        if (meta?.droppedAt) {
          await addDroppedEvent(projectId, name);
        } else {
          await removeDroppedEvent(projectId, name);
        }
      },
      { timeout: ACTION_TX_TIMEOUT_MS, maxWait: ACTION_TX_TIMEOUT_MS }
    );
  } catch (error) {
    logger.error('Could not reconcile dropped-event Redis set', {
      projectId,
      name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function lockKey(projectId: string, name: string) {
  return `event-drop:${projectId}:${name}`;
}

/**
 * Shared project lock first (a full Redis resync takes it exclusive), then
 * the per-event lock that serializes drop/undrop of one name.
 */
async function lockEvent(tx: Tx, projectId: string, name: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${projectDropLockKey(projectId)}))`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(projectId, name)}))`;
}

/**
 * Runs one drop/undrop for (project, event) at a time: a transaction-scoped
 * Postgres advisory lock serializes concurrent requests, and the Redis write
 * happens inside it, so Redis and event_meta change together.
 */
async function withEventLock<T>(
  projectId: string,
  name: string,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  try {
    return await db.$transaction(
      async (tx) => {
        await lockEvent(tx, projectId, name);
        return fn(tx);
      },
      { timeout: ACTION_TX_TIMEOUT_MS, maxWait: ACTION_TX_TIMEOUT_MS }
    );
  } catch (error) {
    // Guards throw before anything is written.
    if (error instanceof EventDropError) {
      throw error;
    }
    // Redis or Postgres failed mid-way: make Redis match what was committed.
    await reconcileRedis(projectId, name);
    logger.error('Event drop action failed', {
      projectId,
      name,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new EventDropError(
      'UNAVAILABLE',
      'Failed to update the event: Redis or the database is unavailable. Please try again.'
    );
  }
}

export async function dropManagedEvent(
  input: EventActionInput & { reason?: string | null }
) {
  assertActor(input);
  const project = await getProjectOrThrow(input.projectId);
  const usage = await getUsageOfEvent(project, input.name);
  const boards = affectedBoards(usage);

  const result = await withEventLock(project.id, input.name, async (tx) => {
    const meta = await tx.eventMeta.findUnique({
      where: { name_projectId: { name: input.name, projectId: project.id } },
      select: { droppedAt: true },
    });
    const { action, reason } = assertCanDrop({
      name: input.name,
      confirmName: input.confirmName,
      reason: input.reason,
      isDropped: Boolean(meta?.droppedAt),
      usageCount: usageCount(usage),
    });
    const droppedAt = new Date();
    await tx.eventMeta.upsert({
      where: { name_projectId: { name: input.name, projectId: project.id } },
      create: { projectId: project.id, name: input.name, droppedAt },
      update: { droppedAt },
    });
    const audit = await tx.eventDropAudit.create({
      data: {
        projectId: project.id,
        eventName: input.name,
        action,
        reason,
        source: input.source,
        requestedBy: input.requestedBy?.trim() || null,
        chatUrl: input.chatUrl || null,
        boardsAffected: boards,
      },
      select: { id: true },
    });
    // Last step before commit: ingest stops storing new events.
    await addDroppedEvent(project.id, input.name);
    return { action, reason, droppedAt, auditId: audit.id };
  });
  await getEventMetasCached.clear(project.id).catch(() => {});

  await postAuditToSlack(result.auditId, {
    projectName: project.name,
    eventName: input.name,
    action: result.action,
    reason: result.reason,
    source: input.source,
    requestedBy: input.requestedBy,
    chatUrl: input.chatUrl,
    boards,
    extra: 'events sent while dropped are not kept',
  });

  return {
    name: input.name,
    status: 'dropped' as const,
    droppedAt: result.droppedAt.toISOString(),
    auditId: result.auditId,
    boardsAffected: boards,
  };
}

export async function undropManagedEvent(
  input: EventActionInput & { reason?: string | null }
) {
  assertActor(input);
  const project = await getProjectOrThrow(input.projectId);
  const usage = await getUsageOfEvent(project, input.name);
  const boards = affectedBoards(usage);

  const result = await withEventLock(project.id, input.name, async (tx) => {
    const meta = await tx.eventMeta.findUnique({
      where: { name_projectId: { name: input.name, projectId: project.id } },
      select: { droppedAt: true },
    });
    assertCanUndrop({
      name: input.name,
      confirmName: input.confirmName,
      isDropped: Boolean(meta?.droppedAt),
    });
    await tx.eventMeta.update({
      where: { name_projectId: { name: input.name, projectId: project.id } },
      data: { droppedAt: null, clearedAt: null },
    });
    await removeDroppedEvent(project.id, input.name);
    const audit = await tx.eventDropAudit.create({
      data: {
        projectId: project.id,
        eventName: input.name,
        action: 'undrop',
        // Start of the gap, so the board note shows it even for a drop that
        // has no audit row (made before the audit log existed).
        droppedFrom: meta!.droppedAt,
        reason: input.reason?.trim() || null,
        source: input.source,
        requestedBy: input.requestedBy?.trim() || null,
        chatUrl: input.chatUrl || null,
        boardsAffected: boards,
      },
      select: { id: true },
    });
    return { auditId: audit.id };
  });
  await getEventMetasCached.clear(project.id).catch(() => {});

  await postAuditToSlack(result.auditId, {
    projectName: project.name,
    eventName: input.name,
    action: 'undrop',
    reason: input.reason?.trim() || null,
    source: input.source,
    requestedBy: input.requestedBy,
    chatUrl: input.chatUrl,
    boards,
    extra: 'new events are stored again; events sent while dropped are not recovered',
  });

  return {
    name: input.name,
    status: 'active' as const,
    auditId: result.auditId,
  };
}

/**
 * Keep mark: an audit row with action 'keep' (the note is its reason) or
 * 'unkeep'. Nothing else changes: ingest, Redis and drops are untouched.
 */
export async function setEventKeep(
  input: Omit<EventActionInput, 'confirmName'> & {
    keep: boolean;
    note?: string | null;
  }
) {
  assertActor({ ...input, confirmName: input.name });
  const project = await getProjectOrThrow(input.projectId);
  const note = input.note?.trim() ?? '';
  if (input.keep && note.length === 0) {
    throw new EventDropError(
      'INVALID_INPUT',
      'A note is required: say what uses this event (e.g. a skill or a query)'
    );
  }
  if (note.length > KEEP_NOTE_MAX_LENGTH) {
    throw new EventDropError(
      'INVALID_INPUT',
      `The note can be at most ${KEEP_NOTE_MAX_LENGTH} characters`
    );
  }
  const audit = await db.eventDropAudit.create({
    data: {
      projectId: project.id,
      eventName: input.name,
      action: input.keep ? 'keep' : 'unkeep',
      reason: input.keep ? note : note || null,
      source: input.source,
      requestedBy: input.requestedBy?.trim() || null,
      chatUrl: input.chatUrl || null,
    },
    select: { id: true, createdAt: true },
  });
  return {
    name: input.name,
    kept: input.keep,
    note: input.keep ? note : null,
    keptAt: input.keep ? audit.createdAt.toISOString() : null,
    auditId: audit.id,
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listEventDropAudit(projectId: string, limit = 50) {
  const take = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
  const rows = await db.eventDropAudit.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take,
  });
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    projectId: row.projectId,
    eventName: row.eventName,
    action: row.action as 'drop' | 'drop_anyway' | 'undrop' | 'keep' | 'unkeep',
    reason: row.reason,
    source: row.source as EventDropSource,
    actor: row.actor,
    requestedBy: row.requestedBy,
    chatUrl: row.chatUrl,
    boardsAffected: Array.isArray(row.boardsAffected)
      ? (row.boardsAffected as { id: string; name: string; url: string; active: boolean }[])
      : [],
    slackPosted: row.slackPosted,
  }));
}

/**
 * Board/report opened. One upsert, and repeat opens within 10 minutes write
 * nothing (the WHERE on the conflict branch skips the update).
 */
export async function recordResourceView(input: {
  projectId: string;
  resourceType: 'dashboard' | 'report';
  resourceId: string;
}) {
  // Only record views of a board/report that belongs to the project the
  // caller has access to (tRPC checks access to projectId).
  const owned =
    input.resourceType === 'dashboard'
      ? await db.dashboard.findFirst({
          where: { id: input.resourceId, projectId: input.projectId },
          select: { id: true },
        })
      : UUID_PATTERN.test(input.resourceId)
        ? await db.report.findFirst({
            where: { id: input.resourceId, projectId: input.projectId },
            select: { id: true },
          })
        : null;
  if (!owned) {
    return false;
  }
  const now = new Date();
  const cutoff = new Date(now.getTime() - VIEW_THROTTLE_MS);
  await db.$executeRaw`
    INSERT INTO "resource_views" ("resourceType", "resourceId", "projectId", "lastViewedAt", "viewCount")
    VALUES (${input.resourceType}, ${input.resourceId}, ${input.projectId}, ${now.toISOString()}::timestamp, 1)
    ON CONFLICT ("resourceType", "resourceId") DO UPDATE
      SET "lastViewedAt" = EXCLUDED."lastViewedAt", "viewCount" = "resource_views"."viewCount" + 1
      WHERE "resource_views"."lastViewedAt" < ${cutoff.toISOString()}::timestamp`;
  return true;
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

const ACTION_LABEL: Record<string, string> = {
  drop: 'Dropped',
  drop_anyway: 'Dropped anyway',
  undrop: 'Undropped',
};

function slackEscape(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildSlackText(input: {
  projectName: string;
  eventName: string;
  action: string;
  reason: string | null;
  source: EventDropSource;
  requestedBy?: string | null;
  chatUrl?: string | null;
  boards: { name: string; url: string; active: boolean }[];
  extra?: string;
}) {
  const lines = [
    `*${ACTION_LABEL[input.action] ?? input.action}* \`${slackEscape(input.eventName)}\` in ${slackEscape(input.projectName)} (OpenPanel)`,
  ];
  if (input.reason) {
    lines.push(`Reason: ${slackEscape(input.reason)}`);
  }
  let via = input.source === 'Agent' ? 'Agent' : 'UI';
  if (input.source === 'Agent') {
    const who = input.requestedBy ? `asked by ${slackEscape(input.requestedBy)}` : '';
    const chat =
      input.chatUrl && /^https?:\/\//i.test(input.chatUrl)
        ? `<${input.chatUrl.replace(/[<>|]/g, '')}|chat>`
        : '';
    const detail = [who, chat].filter(Boolean).join(', ');
    if (detail) {
      via += ` (${detail})`;
    }
  }
  lines.push(`Via: ${via}`);
  if (input.boards.length > 0) {
    const shown = input.boards.slice(0, SLACK_PREVIEW_BOARDS).map((b) => {
      const name = slackEscape(b.name.replace(/[<>|]/g, ''));
      const link = /^https?:\/\//i.test(b.url) ? `<${b.url}|${name}>` : name;
      return `${link}${b.active ? ' (active)' : ''}`;
    });
    const more = input.boards.length - shown.length;
    lines.push(
      `Boards: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
    );
  }
  if (input.extra) {
    lines.push(input.extra);
  }
  return lines.join('\n');
}

async function postAuditToSlack(
  auditId: string,
  message: Parameters<typeof buildSlackText>[0]
) {
  const url = process.env.OPENPANEL_SLACK_WEBHOOK_URL;
  if (!url) {
    return;
  }
  let posted = false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: buildSlackText(message) }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    posted = res.ok;
    if (!res.ok) {
      logger.warn('Slack post for event drop failed', { status: res.status });
    }
  } catch (error) {
    logger.warn('Slack post for event drop failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await db.eventDropAudit
    .update({ where: { id: auditId }, data: { slackPosted: posted } })
    .catch(() => {});
}
