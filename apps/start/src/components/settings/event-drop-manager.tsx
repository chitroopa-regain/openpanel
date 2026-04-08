import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { handleError, useTRPC } from '@/integrations/trpc/react';
import { showConfirm } from '@/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const PROTECTED_EVENTS = ['session_start', 'session_end', 'screen_view'];
const PAGE_SIZE = 25;

type EventRow = {
  name: string;
  count: number;
  status: 'protected' | 'active' | 'dropped';
  droppedAt: Date | null;
};

function EventTable({
  rows,
  page,
  setPage,
  isPending,
  onDrop,
  onUndrop,
  onClear,
}: {
  rows: EventRow[];
  page: number;
  setPage: (fn: (p: number) => number) => void;
  isPending: boolean;
  onDrop: (name: string) => void;
  onUndrop: (name: string) => void;
  onClear: (name: string) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const visible = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  if (rows.length === 0) {
    return <p className="py-4 text-sm text-muted-foreground">No events.</p>;
  }

  return (
    <>
      <div className="rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-2 text-left font-medium">Event Name</th>
              <th className="px-4 py-2 text-right font-medium">Count</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.name} className="border-b last:border-0">
                <td className="px-4 py-2 font-mono text-sm">{row.name}</td>
                <td className="px-4 py-2 text-right tabular-nums">
                  {row.count.toLocaleString()}
                </td>
                <td className="px-4 py-2">
                  {row.status === 'protected' && (
                    <Badge variant="secondary">Protected</Badge>
                  )}
                  {row.status === 'active' && (
                    <Badge variant="success">Active</Badge>
                  )}
                  {row.status === 'dropped' && (
                    <Badge variant="destructive">Dropped</Badge>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {row.status === 'active' && (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={isPending}
                        onClick={() => onDrop(row.name)}
                      >
                        Drop
                      </Button>
                    )}
                    {row.status === 'dropped' && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isPending}
                          onClick={() => onUndrop(row.name)}
                        >
                          Undrop
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isPending}
                          onClick={() => onClear(row.name)}
                        >
                          Clear again
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Showing {safePage * PAGE_SIZE + 1}–
            {Math.min((safePage + 1) * PAGE_SIZE, rows.length)} of{' '}
            {rows.length}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={safePage === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={safePage >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

export default function EventDropManager({
  projectId,
}: {
  projectId: string;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [activePage, setActivePage] = useState(0);
  const [droppedPage, setDroppedPage] = useState(0);

  const eventsQuery = useQuery(
    trpc.chart.events.queryOptions({ projectId, includeDropped: true }),
  );

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: trpc.chart.events.queryKey({
        projectId,
        includeDropped: true,
      }),
    });
    queryClient.invalidateQueries({
      queryKey: trpc.chart.events.queryKey({ projectId }),
    });
  };

  const dropMutation = useMutation(
    trpc.event.dropEvent.mutationOptions({
      onSuccess: invalidate,
      onError: handleError,
    }),
  );

  const undropMutation = useMutation(
    trpc.event.undropEvent.mutationOptions({
      onSuccess: invalidate,
      onError: handleError,
    }),
  );

  const clearMutation = useMutation(
    trpc.event.clearDroppedEvent.mutationOptions({
      onSuccess: invalidate,
      onError: handleError,
    }),
  );

  const allRows: EventRow[] = useMemo(
    () =>
      (eventsQuery.data ?? [])
        .filter((e) => e.name !== '*' && !e.isCustomEvent)
        .map((e) => {
          const isProtected =
            (e as any).isProtected ?? PROTECTED_EVENTS.includes(e.name);
          const isDropped = !!(e as any).droppedAt;
          return {
            name: e.name,
            count: e.count,
            status: isProtected
              ? 'protected'
              : isDropped
                ? 'dropped'
                : 'active',
            droppedAt: isDropped ? new Date((e as any).droppedAt) : null,
          } satisfies EventRow;
        }),
    [eventsQuery.data],
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return allRows;
    const q = search.toLowerCase();
    return allRows.filter((r) => r.name.toLowerCase().includes(q));
  }, [allRows, search]);

  const activeRows = useMemo(
    () =>
      filtered.filter(
        (r) => r.status === 'active' || r.status === 'protected',
      ),
    [filtered],
  );
  const droppedRows = useMemo(
    () =>
      filtered
        .filter((r) => r.status === 'dropped')
        .sort(
          (a, b) =>
            (b.droppedAt?.getTime() ?? 0) - (a.droppedAt?.getTime() ?? 0),
        ),
    [filtered],
  );

  const isPending =
    dropMutation.isPending ||
    undropMutation.isPending ||
    clearMutation.isPending;

  const handleDrop = (name: string) => {
    showConfirm({
      title: `Drop "${name}"?`,
      text: 'Future events will be blocked. Historical data will be deleted from ClickHouse (async, best-effort). Session and profile data are not affected. Deleted history is not restored on undrop.',
      confirmVariant: 'destructive',
      onConfirm: () => dropMutation.mutate({ projectId, name }),
    });
  };

  const handleUndrop = (name: string) => {
    showConfirm({
      title: `Undrop "${name}"?`,
      text: 'Future events with this name will be ingested again. Previously deleted historical data will not be restored.',
      confirmVariant: 'destructive',
      onConfirm: () => undropMutation.mutate({ projectId, name }),
    });
  };

  const handleClear = (name: string) => {
    clearMutation.mutate({ projectId, name });
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-medium">Event Management</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Drop events to block future ingestion and delete historical data.
        </p>
      </div>

      <div className="relative max-w-sm">
        <Input
          placeholder="Search events..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setActivePage(0);
            setDroppedPage(0);
          }}
        />
        {search && (
          <button
            type="button"
            onClick={() => {
              setSearch('');
              setActivePage(0);
              setDroppedPage(0);
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted-foreground hover:text-foreground"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {eventsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading events...</p>
      ) : search.trim() ? (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {filtered.length} result{filtered.length !== 1 ? 's' : ''} for
            &quot;{search}&quot;
          </p>
          <EventTable
            rows={filtered}
            page={activePage}
            setPage={setActivePage}
            isPending={isPending}
            onDrop={handleDrop}
            onUndrop={handleUndrop}
            onClear={handleClear}
          />
        </div>
      ) : (
        <Tabs defaultValue="active">
          <TabsList>
            <TabsTrigger value="active">
              Active ({activeRows.length})
            </TabsTrigger>
            <TabsTrigger value="dropped">
              Dropped ({droppedRows.length})
            </TabsTrigger>
          </TabsList>
          <TabsContent value="active" className="mt-4 space-y-4">
            <EventTable
              rows={activeRows}
              page={activePage}
              setPage={setActivePage}
              isPending={isPending}
              onDrop={handleDrop}
              onUndrop={handleUndrop}
              onClear={handleClear}
            />
          </TabsContent>
          <TabsContent value="dropped" className="mt-4 space-y-4">
            <EventTable
              rows={droppedRows}
              page={droppedPage}
              setPage={setDroppedPage}
              isPending={isPending}
              onDrop={handleDrop}
              onUndrop={handleUndrop}
              onClear={handleClear}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
