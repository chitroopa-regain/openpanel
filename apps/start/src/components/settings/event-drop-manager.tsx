import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { handleError, useTRPC } from '@/integrations/trpc/react';
import { cn } from '@/utils/cn';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LockIcon, SearchIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { EventAuditLog, SourceCell } from './event-management/event-audit-log';
import {
  DropDialog,
  StatusBadge,
  UndropDialog,
  UsedInSheet,
} from './event-management/event-dialogs';
import {
  ACTION_LABEL,
  dateTime,
  formatPct,
  type ManagedEvent,
  type ManagedEventsData,
  places,
  shortCount,
  shortDate,
  timeAgo,
} from './event-management/format';

const PAGE_SIZE = 100;
const REPLAY_POLL_MS = 15 * 1000;
const COOLDOWN_REFETCH_SLACK_MS = 1000;

function nextEventsRefetch(events: ManagedEvent[] | undefined): number | false {
  if (!events) {
    return false;
  }
  if (events.some((e) => e.dropBlocked?.reason === 'replay')) {
    return REPLAY_POLL_MS;
  }
  const now = Date.now();
  const ends = events
    .map((e) => (e.dropBlocked?.until ? new Date(e.dropBlocked.until).getTime() : null))
    .filter((t): t is number => t !== null && t > now);
  if (ends.length === 0) {
    return false;
  }
  return Math.min(...ends) - now + COOLDOWN_REFETCH_SLACK_MS;
}
const HIGH_VOLUME_PCT = 0.5;

type Filter = 'all' | 'unused' | 'used' | 'dropped' | 'protected';
type SortKey = 'name' | 'volume1d' | 'volume7d' | 'volume30d' | 'pct' | 'used';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unused', label: 'Not used' },
  { key: 'used', label: 'Used' },
  { key: 'dropped', label: 'Dropped' },
  { key: 'protected', label: 'Protected' },
];

const PROTECTED_TITLE =
  'Protected: purchase, revenue, attribution, crash, A/B, paywall, onboarding and session events cannot be dropped';

function category(e: ManagedEvent): Filter {
  if (e.status === 'dropped') {
    return 'dropped';
  }
  if (e.status === 'protected') {
    return 'protected';
  }
  return e.usageCount > 0 ? 'used' : 'unused';
}

function sortValue(e: ManagedEvent, key: SortKey): number | string {
  switch (key) {
    case 'name':
      return e.name;
    case 'volume1d':
      return e.volume1d ?? -1;
    case 'volume7d':
      return e.volume7d ?? -1;
    case 'volume30d':
      return e.volume30d ?? -1;
    case 'pct':
      return e.pctOfProject ?? -1;
    case 'used':
      return e.usageCount;
  }
}

function Sparkline({
  values,
  dropped,
}: {
  values: number[] | null;
  dropped: boolean;
}) {
  if (!values || values.length < 2) {
    return <span className="text-muted-foreground">—</span>;
  }
  const width = 72;
  const height = 20;
  const max = Math.max(...values) || 1;
  const points = values
    .map(
      (v, i) =>
        `${((i * (width - 2)) / (values.length - 1) + 1).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`
    )
    .join(' ');
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className="block"
    >
      <polyline
        points={points}
        fill="none"
        stroke={dropped ? 'rgb(242 103 125)' : 'rgb(156 163 175)'}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = 'right',
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: 1 | -1 };
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
}) {
  const arrow = sort.key === sortKey ? (sort.dir < 0 ? ' ▾' : ' ▴') : '';
  return (
    <th
      className={cn(
        'px-3 py-2 font-medium',
        align === 'right' ? 'text-right' : 'text-left'
      )}
      aria-sort={
        sort.key === sortKey
          ? sort.dir < 0
            ? 'descending'
            : 'ascending'
          : 'none'
      }
    >
      <button
        type="button"
        className="whitespace-nowrap hover:text-foreground"
        onClick={() => onSort(sortKey)}
      >
        {label}
        {arrow}
      </button>
    </th>
  );
}

function Stats({ data }: { data: ManagedEventsData | undefined }) {
  const totals = data?.totals;
  const unusedShare =
    totals?.volume1d && totals.unusedVolume1d !== null
      ? Math.round((100 * totals.unusedVolume1d) / totals.volume1d)
      : null;
  return (
    <div className="flex flex-wrap gap-x-7 gap-y-3">
      <div>
        <div className="text-lg font-semibold tabular-nums">
          {totals ? totals.events.toLocaleString('en-IN') : '—'}
        </div>
        <div className="text-sm text-muted-foreground">events</div>
      </div>
      <div>
        <div className="text-lg font-semibold tabular-nums">
          {totals?.volume1d != null ? `${shortCount(totals.volume1d)}/day` : '—'}
        </div>
        <div className="text-sm text-muted-foreground">
          volume{data?.volumeDay ? `, ${shortDate(data.volumeDay)}` : ''}
        </div>
      </div>
      <div>
        <div className="text-lg font-semibold tabular-nums">
          {totals ? totals.unusedEvents.toLocaleString('en-IN') : '—'}
          {totals?.unusedVolume1d != null &&
            ` · ${shortCount(totals.unusedVolume1d)}/day`}
        </div>
        <div className="text-sm text-muted-foreground">
          not used anywhere
          {unusedShare !== null && ` (${unusedShare}% of volume)`}
        </div>
      </div>
    </div>
  );
}

function ActionCell({
  event,
  onDrop,
  onUndrop,
}: {
  event: ManagedEvent;
  onDrop: (e: ManagedEvent) => void;
  onUndrop: (e: ManagedEvent) => void;
}) {
  if (event.status === 'dropped') {
    const recoverable =
      event.recoverableUntil &&
      new Date(event.recoverableUntil).getTime() > Date.now();
    return (
      <div className="flex flex-col items-end">
        <Button variant="outline" size="sm" onClick={() => onUndrop(event)}>
          Undrop
        </Button>
        {recoverable && (
          <div className="mt-1 whitespace-nowrap text-sm text-muted-foreground">
            until {dateTime(event.recoverableUntil)}
          </div>
        )}
      </div>
    );
  }
  if (event.status === 'protected') {
    return (
      <span
        className="inline-flex items-center gap-1 whitespace-nowrap text-sm text-muted-foreground"
        title={PROTECTED_TITLE}
      >
        <LockIcon className="size-3" /> Locked
      </span>
    );
  }
  const blocked = event.dropBlocked;
  const blockedNow =
    blocked !== null &&
    (blocked.until === null || new Date(blocked.until).getTime() > Date.now());
  if (blocked && blockedNow) {
    return (
      <div className="flex flex-col items-end">
        <Button
          variant="outline"
          size="sm"
          disabled
          aria-describedby={`drop-blocked-${event.name}`}
          className="whitespace-nowrap"
        >
          {blocked.reason === 'replay' ? 'Replaying…' : 'Drop'}
        </Button>
        <div
          id={`drop-blocked-${event.name}`}
          className="mt-1 max-w-[260px] text-right text-sm text-muted-foreground"
        >
          {blocked.message}
        </div>
      </div>
    );
  }
  if (event.usageCount > 0) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="whitespace-nowrap border-destructive/60 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => onDrop(event)}
      >
        Drop anyway
      </Button>
    );
  }
  return (
    <Button variant="destructive" size="sm" onClick={() => onDrop(event)}>
      Drop
    </Button>
  );
}

export default function EventDropManager({
  projectId,
}: {
  projectId: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'events' | 'audit'>('events');
  const [filter, setFilter] = useState<Filter>('all');
  const [highVolume, setHighVolume] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({
    key: 'volume1d',
    dir: -1,
  });
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [usedFor, setUsedFor] = useState<ManagedEvent | null>(null);
  const [dropFor, setDropFor] = useState<ManagedEvent | null>(null);
  const [undropFor, setUndropFor] = useState<ManagedEvent | null>(null);

  // While a replay is pending or running, poll both lists so "Replaying…" and
  // the audit row's replay status update when the worker finishes. During a
  // re-drop cooldown, refetch when the earliest one ends so Drop comes back.
  const eventsQuery = useQuery(
    trpc.event.managedEvents.queryOptions(
      { projectId },
      { refetchInterval: (query) => nextEventsRefetch(query.state.data?.events) }
    )
  );
  const auditQuery = useQuery(
    trpc.event.eventDropAudit.queryOptions(
      { projectId, limit: 100 },
      {
        refetchInterval: (query) =>
          query.state.data?.some(
            (row) =>
              row.replay?.status === 'pending' ||
              row.replay?.status === 'running'
          )
            ? REPLAY_POLL_MS
            : false,
      }
    )
  );

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: trpc.event.managedEvents.queryKey({ projectId }),
    });
    queryClient.invalidateQueries({
      queryKey: trpc.event.eventDropAudit.queryKey({ projectId }),
    });
    queryClient.invalidateQueries({
      queryKey: trpc.chart.events.queryKey({ projectId }),
    });
  };

  const dropMutation = useMutation(
    trpc.event.dropEvent.mutationOptions({
      onSuccess: (result) => {
        setDropFor(null);
        invalidate();
        toast(`Dropped "${result.name}". Recoverable for 24 h.`);
      },
      onError: handleError,
    })
  );
  const undropMutation = useMutation(
    trpc.event.undropEvent.mutationOptions({
      onSuccess: (result) => {
        setUndropFor(null);
        invalidate();
        toast(
          `Undropped "${result.name}"${result.replayRequestId ? ', replay started' : ''}.`
        );
      },
      onError: handleError,
    })
  );

  const all = eventsQuery.data?.events ?? [];
  const counts = useMemo(() => {
    const c: Record<Filter, number> = {
      all: all.length,
      unused: 0,
      used: 0,
      dropped: 0,
      protected: 0,
    };
    for (const e of all) {
      c[category(e)]++;
    }
    return c;
  }, [all]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = all.filter((e) => {
      if (highVolume) {
        if (
          category(e) !== 'unused' ||
          (e.pctOfProject ?? 0) < HIGH_VOLUME_PCT
        ) {
          return false;
        }
      } else if (filter !== 'all' && category(e) !== filter) {
        return false;
      }
      return !needle || e.name.toLowerCase().includes(needle);
    });
    return filtered.sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      const diff =
        typeof av === 'string'
          ? av.localeCompare(bv as string)
          : av - (bv as number);
      return diff * sort.dir;
    });
  }, [all, filter, highVolume, search, sort]);

  const onSort = (key: SortKey) => {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 1 ? -1 : 1 }
        : { key, dir: key === 'name' ? 1 : -1 }
    );
  };

  const lastAction = auditQuery.data?.[0];
  const visible = rows.slice(0, limit);

  return (
    <div className="space-y-5 leading-normal">
      <div>
        <h3 className="text-lg font-medium">Event Management</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Drop sends new events to a 24 h holding topic instead of ClickHouse.
          Past data is never deleted.
        </p>
      </div>

      <Stats data={eventsQuery.data} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'events' | 'audit')}>
        <TabsList>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="audit">Audit log</TabsTrigger>
        </TabsList>

        <TabsContent value="events" className="mt-4 space-y-3">
          {lastAction && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm">
              <span className="text-muted-foreground">Last action</span>
              <span>
                {dateTime(lastAction.createdAt)} · {lastAction.actor} ·{' '}
                <b className="font-medium">
                  {ACTION_LABEL[lastAction.action]}
                </b>{' '}
                <span className="font-mono">{lastAction.eventName}</span>
              </span>
              <span className="text-muted-foreground">
                via <SourceCell row={lastAction} />
              </span>
              <button
                type="button"
                className="ml-auto text-blue-500 hover:underline"
                onClick={() => setTab('audit')}
              >
                Audit log →
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <label className="relative flex h-9 w-full max-w-xs items-center">
              <SearchIcon className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
              <input
                className="h-9 w-full rounded-md border bg-card pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="Search events"
                aria-label="Search events"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setLimit(PAGE_SIZE);
                }}
              />
            </label>
            <div className="flex overflow-hidden rounded-md border">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={cn(
                    'border-r px-3 py-1.5 text-sm last:border-r-0',
                    !highVolume && filter === f.key
                      ? 'bg-def-200 font-medium text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => {
                    setFilter(f.key);
                    setHighVolume(false);
                    setLimit(PAGE_SIZE);
                  }}
                >
                  {f.label}{' '}
                  <span className="text-sm tabular-nums opacity-70">
                    {counts[f.key]}
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              title="Not used and at least 0.5% of this project's volume"
              className={cn(
                'rounded-full border border-dashed px-3 py-1.5 text-sm',
                highVolume
                  ? 'border-solid bg-def-200 text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => {
                setHighVolume((v) => !v);
                setFilter('all');
                setLimit(PAGE_SIZE);
              }}
            >
              Not used + high volume
            </button>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <table className="w-full leading-normal min-w-[1080px] text-sm">
              <thead>
                <tr className="border-b bg-def-100 text-sm text-muted-foreground">
                  <SortHeader
                    label="Event"
                    sortKey="name"
                    sort={sort}
                    onSort={onSort}
                    align="left"
                  />
                  <SortHeader
                    label="Volume 1d"
                    sortKey="volume1d"
                    sort={sort}
                    onSort={onSort}
                  />
                  <SortHeader
                    label="7d"
                    sortKey="volume7d"
                    sort={sort}
                    onSort={onSort}
                  />
                  <SortHeader
                    label="30d"
                    sortKey="volume30d"
                    sort={sort}
                    onSort={onSort}
                  />
                  <th className="px-3 py-2 text-left font-medium">Trend 30d</th>
                  <SortHeader
                    label="% of project"
                    sortKey="pct"
                    sort={sort}
                    onSort={onSort}
                  />
                  <th className="px-3 py-2 text-left font-medium">Last seen</th>
                  <SortHeader
                    label="Used in"
                    sortKey="used"
                    sort={sort}
                    onSort={onSort}
                    align="left"
                  />
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {eventsQuery.isLoading && (
                  <tr>
                    <td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">
                      Loading events…
                    </td>
                  </tr>
                )}
                {!eventsQuery.isLoading && visible.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">
                      No events match.
                    </td>
                  </tr>
                )}
                {visible.map((event) => (
                  <tr key={event.name} className="border-b last:border-0">
                    <td className="max-w-[300px] px-3 py-2.5">
                      <div className="break-words font-mono text-[13px]" title={event.name}>
                        {event.name}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {shortCount(event.volume1d)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {shortCount(event.volume7d)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {shortCount(event.volume30d)}
                    </td>
                    <td className="px-3 py-2.5">
                      <Sparkline
                        values={event.trend30d}
                        dropped={event.status === 'dropped'}
                      />
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {formatPct(event.pctOfProject)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-sm">
                      {event.status === 'dropped' ? (
                        dateTime(event.droppedAt)
                      ) : (
                        <span className="text-muted-foreground">
                          {timeAgo(event.lastSeen)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {event.usageCount > 0 ? (
                        <button
                          type="button"
                          className="whitespace-nowrap text-blue-500 hover:underline"
                          onClick={() => setUsedFor(event)}
                        >
                          {places(event.usageCount)}
                        </button>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={event.status} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <ActionCell
                        event={event}
                        onDrop={setDropFor}
                        onUndrop={setUndropFor}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>
              Showing {visible.length.toLocaleString('en-IN')} of{' '}
              {rows.length.toLocaleString('en-IN')} events.
              {eventsQuery.data && !eventsQuery.data.volumeAvailable &&
                ' Volume is not available yet (event_name_daily is missing).'}
            </span>
            {rows.length > visible.length && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLimit((l) => l + PAGE_SIZE)}
              >
                Show {Math.min(PAGE_SIZE, rows.length - visible.length)} more
              </Button>
            )}
          </div>
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          <EventAuditLog
            rows={auditQuery.data ?? []}
            isLoading={auditQuery.isLoading}
          />
        </TabsContent>
      </Tabs>

      <UsedInSheet event={usedFor} onClose={() => setUsedFor(null)} />
      {dropFor && (
        <DropDialog
          key={dropFor.name}
          event={dropFor}
          isPending={dropMutation.isPending}
          onCancel={() => setDropFor(null)}
          onConfirm={({ confirmName, reason }) =>
            dropMutation.mutate({
              projectId,
              name: dropFor.name,
              confirmName,
              reason,
            })
          }
        />
      )}
      {undropFor && (
        <UndropDialog
          key={undropFor.name}
          event={undropFor}
          isPending={undropMutation.isPending}
          onCancel={() => setUndropFor(null)}
          onConfirm={({ replay }) =>
            undropMutation.mutate({
              projectId,
              name: undropFor.name,
              confirmName: undropFor.name,
              replay,
            })
          }
        />
      )}
    </div>
  );
}
