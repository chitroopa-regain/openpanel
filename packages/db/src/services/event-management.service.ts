/**
 * Events settings page and the /manage REST API share these functions: one
 * code path for listing, dropping and undropping event names.
 *
 * Drop = add the name to the Redis set op:dropped:<projectId> (Jitsu ingest
 * reads it and sends new events to the 24 h holding topic) + stamp
 * event_meta.droppedAt. ClickHouse history is never deleted.
 */
import sqlstring from 'sqlstring';
import { ch, TABLE_NAMES } from '../clickhouse/client';
import { logger } from '../logger';
import { db } from '../prisma-client';
import { addDroppedEvent, removeDroppedEvent } from './drop-events.service';
import {
  assertCanDrop,
  assertCanUndrop,
  EventDropError,
  type EventDropSource,
  getReplayWindow,
  HIGH_VOLUME_PCT,
  HOLD_WINDOW_MS,
  isProtectedEventName,
} from './event-drop-rules';
import { getEventMetasCached } from './event.service';
import {
  affectedBoards,
  buildEventUsage,
  type EventUsage,
  type OtherUse,
  type UsedInItem,
  usageCount,
} from './event-usage';

export const EVENT_NAME_DAILY_TABLE = 'event_name_daily';
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
  recoverableUntil: string | null;
};

export type ManagedEventsResult = {
  events: ManagedEvent[];
  volumeAvailable: boolean;
  /** YYYY-MM-DD of the "1d" column (yesterday, the last full day) */
  volumeDay: string | null;
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
  volume7d: number;
  volume30d: number;
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

/**
 * Reads the rollup built by the regainapp job. FINAL makes the sums right for
 * both SummingMergeTree and ReplacingMergeTree. A missing table (or any
 * ClickHouse error) gives `available: false` and the page shows "—".
 */
export async function getEventVolumes(projectId: string): Promise<{
  available: boolean;
  volumeDay: string | null;
  rows: Map<string, VolumeRow>;
}> {
  const query = `
    SELECT
      name,
      sumIf(e, day = today() - 1) AS v1,
      sumIf(e, day >= today() - 7 AND day < today()) AS v7,
      sumIf(e, day >= today() - 30 AND day < today()) AS v30,
      max(ls) AS last_seen_ts,
      groupArray((toString(day), e)) AS daily,
      toString(today() - 1) AS volume_day
    FROM (
      SELECT name, day, toFloat64(sum(events)) AS e, toUnixTimestamp(max(last_seen)) AS ls
      FROM ${EVENT_NAME_DAILY_TABLE} FINAL
      WHERE project_id = ${sqlstring.escape(projectId)} AND day >= today() - ${TREND_DAYS}
      GROUP BY name, day
    )
    GROUP BY name`;
  try {
    const res = await ch.query({ query, format: 'JSONEachRow' });
    const data = await res.json<{
      name: string;
      v1: number;
      v7: number;
      v30: number;
      last_seen_ts: number | string;
      daily: [string, number][];
      volume_day: string;
    }>();
    const rows = new Map<string, VolumeRow>();
    let volumeDay: string | null = null;
    for (const row of data) {
      volumeDay = row.volume_day;
      const byDay = new Map(row.daily.map(([day, e]) => [day, Number(e)]));
      const trend30d: number[] = [];
      for (let i = TREND_DAYS - 1; i >= 0; i--) {
        trend30d.push(byDay.get(addDays(row.volume_day, -i)) ?? 0);
      }
      const lastSeenTs = Number(row.last_seen_ts);
      rows.set(row.name, {
        volume1d: Number(row.v1),
        volume7d: Number(row.v7),
        volume30d: Number(row.v30),
        lastSeen: lastSeenTs > 0 ? new Date(lastSeenTs * 1000).toISOString() : null,
        trend30d,
      });
    }
    return { available: true, volumeDay, rows };
  } catch (error) {
    logger.warn('event_name_daily unavailable; Events page shows no volume', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { available: false, volumeDay: null, rows: new Map() };
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
      return event.status === 'active' && event.usageCount === 0;
    case 'unused_high':
      return (
        event.status === 'active' &&
        event.usageCount === 0 &&
        (event.pctOfProject ?? 0) >= HIGH_VOLUME_PCT
      );
  }
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
      volume7d: volumes.available ? (volume?.volume7d ?? 0) : null,
      volume30d: volumes.available ? (volume?.volume30d ?? 0) : null,
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
      recoverableUntil: dropped
        ? new Date(dropped.getTime() + HOLD_WINDOW_MS).toISOString()
        : null,
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

/**
 * Ingest re-reads the dropped set every 5 s, so an undrop takes up to that
 * long to reach it. The replay window runs this much past the undrop; the
 * replay worker must not start a request before its to_ts.
 */
export const INGEST_REFRESH_GRACE_MS = 30 * 1000;
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
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(projectId, name)}))`;
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
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(projectId, name)}))`;
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
    // Taken before the Redis write so the replay window covers every held event.
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
    // Last step before commit: ingest starts holding new events.
    await addDroppedEvent(project.id, input.name);
    return { action, reason, droppedAt, auditId: audit.id };
  });
  await getEventMetasCached.clear(project.id).catch(() => {});

  const recoverableUntil = new Date(
    result.droppedAt.getTime() + HOLD_WINDOW_MS
  );
  await postAuditToSlack(result.auditId, {
    projectName: project.name,
    eventName: input.name,
    action: result.action,
    reason: result.reason,
    source: input.source,
    requestedBy: input.requestedBy,
    chatUrl: input.chatUrl,
    boards,
    extra: `recoverable until ${formatUtc(recoverableUntil)}`,
  });

  return {
    name: input.name,
    status: 'dropped' as const,
    droppedAt: result.droppedAt.toISOString(),
    recoverableUntil: recoverableUntil.toISOString(),
    auditId: result.auditId,
    boardsAffected: boards,
  };
}

export async function undropManagedEvent(
  input: EventActionInput & { replay: boolean; reason?: string | null }
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
    // Ingest may keep holding for up to its refresh interval after the SREM.
    const held = getReplayWindow(meta!.droppedAt!, new Date());
    // A quick drop → undrop → drop again could overlap the previous replay's
    // grace period; start after it so no message is copied twice.
    const previous = await tx.eventReplayRequest.findFirst({
      where: { projectId: project.id, eventName: input.name },
      orderBy: { toTs: 'desc' },
      select: { toTs: true },
    });
    const window = {
      fromTs:
        previous && previous.toTs > held.fromTs ? previous.toTs : held.fromTs,
      toTs: new Date(held.toTs.getTime() + INGEST_REFRESH_GRACE_MS),
    };
    const replay = input.replay
      ? await tx.eventReplayRequest.create({
          data: {
            projectId: project.id,
            eventName: input.name,
            fromTs: window.fromTs,
            toTs: window.toTs,
          },
          select: { id: true },
        })
      : null;
    const audit = await tx.eventDropAudit.create({
      data: {
        projectId: project.id,
        eventName: input.name,
        action: replay ? 'undrop_replay' : 'undrop',
        reason: input.reason?.trim() || null,
        source: input.source,
        requestedBy: input.requestedBy?.trim() || null,
        chatUrl: input.chatUrl || null,
        boardsAffected: boards,
        replayRequestId: replay?.id ?? null,
      },
      select: { id: true },
    });
    return { auditId: audit.id, replayRequestId: replay?.id ?? null, window };
  });
  await getEventMetasCached.clear(project.id).catch(() => {});

  await postAuditToSlack(result.auditId, {
    projectName: project.name,
    eventName: input.name,
    action: result.replayRequestId ? 'undrop_replay' : 'undrop',
    reason: input.reason?.trim() || null,
    source: input.source,
    requestedBy: input.requestedBy,
    chatUrl: input.chatUrl,
    boards,
    extra: result.replayRequestId
      ? `replaying ${formatUtc(result.window.fromTs)} → ${formatUtc(result.window.toTs)}`
      : 'no replay',
  });

  return {
    name: input.name,
    status: 'active' as const,
    replayRequestId: result.replayRequestId,
    auditId: result.auditId,
  };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getReplayRequest(id: string) {
  if (!UUID_PATTERN.test(id)) {
    throw new EventDropError('NOT_FOUND', 'Replay request not found');
  }
  const row = await db.eventReplayRequest.findUnique({ where: { id } });
  if (!row) {
    throw new EventDropError('NOT_FOUND', 'Replay request not found');
  }
  return {
    id: row.id,
    projectId: row.projectId,
    eventName: row.eventName,
    fromTs: row.fromTs.toISOString(),
    toTs: row.toTs.toISOString(),
    status: row.status as 'pending' | 'running' | 'done' | 'failed',
    copied: row.copied,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listEventDropAudit(projectId: string, limit = 50) {
  const take = Math.min(Math.max(Math.trunc(limit) || 50, 1), 500);
  const rows = await db.eventDropAudit.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    take,
  });
  const replayIds = rows
    .map((r) => r.replayRequestId)
    .filter((id): id is string => Boolean(id));
  const replays = replayIds.length
    ? await db.eventReplayRequest.findMany({
        where: { id: { in: replayIds } },
        select: { id: true, status: true, copied: true, error: true },
      })
    : [];
  const replayById = new Map(replays.map((r) => [r.id, r]));
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    projectId: row.projectId,
    eventName: row.eventName,
    action: row.action as 'drop' | 'drop_anyway' | 'undrop' | 'undrop_replay',
    reason: row.reason,
    source: row.source as EventDropSource,
    actor: row.actor,
    requestedBy: row.requestedBy,
    chatUrl: row.chatUrl,
    boardsAffected: Array.isArray(row.boardsAffected)
      ? (row.boardsAffected as { id: string; name: string; url: string; active: boolean }[])
      : [],
    slackPosted: row.slackPosted,
    replay: row.replayRequestId
      ? (replayById.get(row.replayRequestId) ?? null)
      : null,
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
  undrop_replay: 'Undropped + replay',
};

function formatUtc(date: Date) {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

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
