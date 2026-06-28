import { FullPageEmptyState } from '@/components/full-page-empty-state';
import { Button, LinkButton } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { createProjectTitle } from '@/utils/title';
import {
  LayoutPanelTopIcon,
  MoreHorizontal,
  PlusIcon,
  RotateCcw,
  ShareIcon,
  TrashIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import FullPageLoadingState from '@/components/full-page-loading-state';
import {
  GrafanaGrid,
  type Layout,
  deriveRowsFromReports,
  useReportLayouts,
} from '@/components/grafana-grid';
import { PageContainer } from '@/components/page-container';
import { PageBreadcrumbs } from '@/components/page-breadcrumbs';
import { PageHeader } from '@/components/page-header';
import { TimeWindowPicker } from '@/components/time-window-picker';
import {
  ReportItem,
  ReportItemSkeleton,
  type DropTarget,
} from '@/components/report/report-item';
import { handleErrorToastOptions, useTRPC } from '@/integrations/trpc/react';
import { pushModal, showConfirm } from '@/modals';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import type { IChartRange, IDateConfig } from '@openpanel/validation';
import { useCallback, useEffect, useMemo, useState } from 'react';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/dashboards_/$dashboardId'
)({
  component: Component,
  head: () => {
    return {
      meta: [
        {
          title: createProjectTitle('Dashboard'),
        },
      ],
    };
  },
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.prefetchQuery(
        context.trpc.dashboard.byId.queryOptions({
          id: params.dashboardId,
          projectId: params.projectId,
        })
      ),
      context.queryClient.prefetchQuery(
        context.trpc.report.list.queryOptions({
          dashboardId: params.dashboardId,
          projectId: params.projectId,
        })
      ),
      context.queryClient.prefetchQuery(
        context.trpc.project.getProjectWithClients.queryOptions({
          projectId: params.projectId,
        })
      ),
      context.queryClient.prefetchQuery(
        context.trpc.organization.get.queryOptions({
          organizationId: params.organizationId,
        })
      ),
    ]);
  },
  pendingComponent: FullPageLoadingState,
});

function Component() {
  const router = useRouter();
  const { organizationId, dashboardId, projectId } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const dashboardQuery = useQuery(
    trpc.dashboard.byId.queryOptions({
      id: dashboardId,
      projectId,
    })
  );

  const reportsQuery = useQuery(
    trpc.report.list.queryOptions({
      dashboardId,
      projectId,
    })
  );
  const projectQuery = useQuery(
    trpc.project.getProjectWithClients.queryOptions({
      projectId,
    })
  );

  const dashboardDeletion = useMutation(
    trpc.dashboard.delete.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        queryClient.invalidateQueries(trpc.dashboard.list.pathFilter());
        toast('Dashboard deleted');
        router.navigate({
          to: '/$organizationId/$projectId/dashboards',
          params: {
            organizationId,
            projectId,
          },
        });
      },
    })
  );

  const reports = reportsQuery.data ?? [];
  const dashboard = dashboardQuery.data;
  const project = projectQuery.data;
  const [isGridReady, setIsGridReady] = useState(false);
  const [enableTransitions, setEnableTransitions] = useState(false);
  const [dashboardRange, setDashboardRange] = useState<IChartRange | null>(
    null
  );
  const [dashboardStartDate, setDashboardStartDate] = useState<string | null>(
    null
  );
  const [dashboardEndDate, setDashboardEndDate] = useState<string | null>(null);
  const [dashboardDateConfig, setDashboardDateConfig] = useState<
    IDateConfig | undefined
  >(undefined);

  const savedDashboardFilter = useMemo(
    () => ({
      range:
        (dashboard?.dashboardRange as IChartRange | null | undefined) ?? null,
      startDate: dashboard?.dashboardStartDate ?? null,
      endDate: dashboard?.dashboardEndDate ?? null,
      dateConfig:
        (dashboard?.dashboardDateConfig as IDateConfig | null | undefined) ??
        undefined,
    }),
    [dashboard]
  );

  useEffect(() => {
    if (!dashboard) return;
    setDashboardRange(savedDashboardFilter.range);
    setDashboardStartDate(savedDashboardFilter.startDate);
    setDashboardEndDate(savedDashboardFilter.endDate);
    setDashboardDateConfig(savedDashboardFilter.dateConfig);
  }, [dashboard?.id, savedDashboardFilter]);

  const isDashboardFilterDirty = useMemo(
    () =>
      dashboardRange !== savedDashboardFilter.range ||
      dashboardStartDate !== savedDashboardFilter.startDate ||
      dashboardEndDate !== savedDashboardFilter.endDate ||
      JSON.stringify(dashboardDateConfig ?? null) !==
        JSON.stringify(savedDashboardFilter.dateConfig ?? null),
    [
      dashboardDateConfig,
      dashboardEndDate,
      dashboardRange,
      dashboardStartDate,
      savedDashboardFilter,
    ]
  );

  const handleDashboardRangeChange = useCallback((value: IChartRange) => {
    setDashboardRange(value);
    if (value !== 'custom') {
      setDashboardStartDate(null);
      setDashboardEndDate(null);
      setDashboardDateConfig(undefined);
    }
  }, []);

  const resetDashboardFilters = useCallback(() => {
    setDashboardRange(null);
    setDashboardStartDate(null);
    setDashboardEndDate(null);
    setDashboardDateConfig(undefined);
  }, []);

  // Local order state for instant feedback during drag-to-reorder. Re-syncs
  // from the server whenever the underlying reports list changes (refetch).
  const [orderedReports, setOrderedReports] = useState(reports);
  useEffect(() => {
    setOrderedReports(reports);
  }, [reports]);

  // Wait for initial render to ensure grid has proper dimensions
  useEffect(() => {
    if (reports.length > 0 && !isGridReady) {
      // Small delay to ensure container has rendered with proper width
      const timer = setTimeout(() => {
        setIsGridReady(true);
        // Enable transitions after initial render
        setTimeout(() => setEnableTransitions(true), 100);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [reports.length, isGridReady]);

  const reportDeletion = useMutation(
    trpc.report.delete.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        queryClient.invalidateQueries(trpc.dashboard.list.pathFilter());
        reportsQuery.refetch();
        toast('Report deleted');
      },
    })
  );

  const reportDuplicate = useMutation(
    trpc.report.duplicate.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        queryClient.invalidateQueries(trpc.dashboard.list.pathFilter());
        reportsQuery.refetch();
        toast('Report duplicated');
      },
    })
  );

  const updateLayout = useMutation(
    trpc.report.updateLayout.mutationOptions({
      onError: handleErrorToastOptions({}),
      // Do NOT refetch here. A single drag fires one updateLayout per moved
      // card; refetching on each success races partial server states against
      // the optimistic `orderedReports` and corrupts the grid. The optimistic
      // state is authoritative for the session; the DB is updated in the
      // background and re-read on the next full load.
    })
  );

  const resetLayout = useMutation(
    trpc.report.resetLayout.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        toast('Layout reset to default');
        reportsQuery.refetch();
      },
    })
  );

  const dashboardUpdate = useMutation(
    trpc.dashboard.update.mutationOptions({
      onError: handleErrorToastOptions({}),
      onSuccess() {
        toast('Dashboard filters updated');
        queryClient.invalidateQueries(trpc.dashboard.list.pathFilter());
        dashboardQuery.refetch();
      },
    })
  );

  const saveDashboardFilters = useCallback(() => {
    dashboardUpdate.mutate({
      id: dashboardId,
      dashboardRange,
      dashboardStartDate,
      dashboardEndDate,
      dashboardDateConfig: dashboardDateConfig ?? null,
    });
  }, [
    dashboardDateConfig,
    dashboardEndDate,
    dashboardId,
    dashboardRange,
    dashboardStartDate,
    dashboardUpdate,
  ]);

  // Convert reports to grid layout format for all breakpoints.
  // Driven by orderedReports so drag-to-reorder is reflected immediately.
  const layouts = useReportLayouts(orderedReports);

  const handleLayoutChange = useCallback((newLayout: Layout[]) => {
    // This is called during dragging/resizing, we'll save on drag/resize stop
  }, []);

  const handleDrop = useCallback(
    (fromId: string, target: DropTarget) => {
      setOrderedReports((current) => {
        // 1. Derive the current row structure from the cards' saved layouts.
        const rows = deriveRowsFromReports(current).map((row) => row.slice());

        // 2. Remove the dragged card from its current row.
        let sourceRowIdx = -1;
        let sourceColIdx = -1;
        for (let r = 0; r < rows.length; r++) {
          const c = rows[r]!.indexOf(fromId);
          if (c >= 0) {
            sourceRowIdx = r;
            sourceColIdx = c;
            break;
          }
        }
        if (sourceRowIdx < 0) return current;
        rows[sourceRowIdx]!.splice(sourceColIdx, 1);

        // Adjust target row index if we removed a card from a row before it.
        let adjTargetRow =
          target.kind === 'newRow' ? target.rowIdx : target.rowIdx;
        if (rows[sourceRowIdx]!.length === 0) {
          // The source row will be removed entirely; rows after it shift up.
          if (sourceRowIdx < adjTargetRow) adjTargetRow -= 1;
        }

        // Now safely remove empty source row.
        if (rows[sourceRowIdx]!.length === 0) rows.splice(sourceRowIdx, 1);

        // 3. Insert at target.
        const MAX_PER_ROW = 4;
        if (target.kind === 'newRow') {
          const clamped = Math.max(0, Math.min(adjTargetRow, rows.length));
          rows.splice(clamped, 0, [fromId]);
        } else {
          const clamped = Math.max(0, Math.min(adjTargetRow, rows.length - 1));
          const row = rows[clamped];
          if (!row) {
            rows.push([fromId]);
          } else if (row.length >= MAX_PER_ROW) {
            // Row is already full (4 cards) — don't allow dropping into it.
            // Cancel the move so the card stays where it was.
            return current;
          } else {
            // If we removed the card from the SAME row before its slot,
            // adjust the column index accordingly.
            let col = target.colIdx;
            if (sourceRowIdx === clamped && sourceColIdx < col) col -= 1;
            row.splice(Math.max(0, Math.min(col, row.length)), 0, fromId);
          }
        }

        // 4. Detect no-op (no structural change). Compare the full ROW
        // structure, not just the flattened order — moving the last card of
        // a row into a new row directly below keeps the flat order identical
        // but changes the rows, so a flat-only check would wrongly bail.
        const beforeRows = deriveRowsFromReports(current)
          .map((r) => r.join(','))
          .join('|');
        const afterRows = rows.map((r) => r.join(',')).join('|');
        if (beforeRows === afterRows) return current;

        // 5. Persist + return a new orderedReports array with updated layouts.
        const next = current.map((r) => ({ ...r }));
        const byId = new Map(next.map((r) => [r.id, r] as const));
        rows.forEach((row, rowIdx) => {
          row.forEach((id, colIdx) => {
            const r = byId.get(id);
            if (!r) return;
            const oldL = (r as any).layout;
            const newLayout = {
              x: colIdx,
              y: rowIdx,
              w: oldL?.w ?? 6,
              h: oldL?.h ?? 4,
              minW: oldL?.minW ?? 3,
              minH: oldL?.minH ?? 3,
            };
            (r as any).layout = { ...(oldL ?? {}), ...newLayout };
            if (!oldL || oldL.x !== colIdx || oldL.y !== rowIdx) {
              updateLayout.mutate({ reportId: id, layout: newLayout });
            }
          });
        });

        // Re-sort next by (y, x) so the array order matches the rendered grid.
        next.sort((a, b) => {
          const la = (a as any).layout;
          const lb = (b as any).layout;
          return la?.y - lb?.y || la?.x - lb?.x;
        });
        return next;
      });
    },
    [updateLayout]
  );

  // Track which row the cursor is currently over so the entire row (cards
  // + plus buttons) can highlight together. null when not hovering any row.
  const [hoveredRowIdx, setHoveredRowIdx] = useState<number | null>(null);
  const handleRowHoverChange = useCallback(
    (rowIdx: number, hovered: boolean) => {
      setHoveredRowIdx((current) => {
        if (hovered) return rowIdx;
        return current === rowIdx ? null : current;
      });
    },
    []
  );

  // Per-card row position lookup so the floating "+" buttons can render at
  // the left/right edges of each row.
  const rowPositionById = useMemo(() => {
    const m = new Map<
      string,
      { rowIdx: number; isFirst: boolean; isLast: boolean }
    >();
    const rows = deriveRowsFromReports(orderedReports);
    rows.forEach((row, rowIdx) => {
      row.forEach((id, colIdx) => {
        m.set(id, {
          rowIdx,
          isFirst: colIdx === 0,
          isLast: colIdx === row.length - 1,
        });
      });
    });
    return m;
  }, [orderedReports]);

  // "Add to row" handler — stash the intended (row, side) and a baseline
  // snapshot of report IDs, then navigate to the create flow. When the user
  // saves the new report and React Query refetches, the effect below picks
  // up the new report and drops it at the requested slot.
  const PENDING_INSERT_KEY = `openpanel:pendingInsert:${dashboardId}`;
  const handleAddAt = useCallback(
    (insertRowIdx: number, side: 'start' | 'end') => {
      try {
        sessionStorage.setItem(
          PENDING_INSERT_KEY,
          JSON.stringify({
            rowIdx: insertRowIdx,
            side,
            baselineIds: orderedReports.map((r) => r.id),
            createdAt: Date.now(),
          })
        );
      } catch {
        // sessionStorage may fail in private mode — fall through to navigate.
      }
      router.navigate({
        to: '/$organizationId/$projectId/reports',
        params: { organizationId, projectId },
        search: { dashboardId },
      });
    },
    [
      PENDING_INSERT_KEY,
      orderedReports,
      router,
      organizationId,
      projectId,
      dashboardId,
    ]
  );

  // After a "Create report" round-trip, place the newly-created report at
  // the previously-clicked slot. Runs on every reports refetch; bails out
  // when there's no pending intent.
  useEffect(() => {
    if (reports.length === 0) return;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(PENDING_INSERT_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const intent = JSON.parse(raw) as {
        rowIdx: number;
        side: 'start' | 'end';
        baselineIds: string[];
      };
      const baseline = new Set(intent.baselineIds);
      const newReport = reports.find((r) => !baseline.has(r.id));
      if (!newReport) return; // not yet refetched
      const rows = deriveRowsFromReports(reports);
      const row = rows[intent.rowIdx];
      const colIdx = intent.side === 'start' ? 0 : row ? row.length : 0;
      handleDrop(newReport.id, {
        kind: 'inRow',
        rowIdx: intent.rowIdx,
        colIdx,
      });
      sessionStorage.removeItem(PENDING_INSERT_KEY);
    } catch {
      sessionStorage.removeItem(PENDING_INSERT_KEY);
    }
    // We intentionally only fire on reports identity changes; handleDrop is
    // stable enough via the updateLayout dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reports]);

  const handleDragStop = useCallback(
    (newLayout: Layout[]) => {
      // Save each changed layout after drag stops
      newLayout.forEach((item) => {
        const report = reports.find((r) => r.id === item.i);
        if (report) {
          const oldLayout = report.layout;
          // Only update if layout actually changed
          if (
            !oldLayout ||
            oldLayout.x !== item.x ||
            oldLayout.y !== item.y ||
            oldLayout.w !== item.w ||
            oldLayout.h !== item.h
          ) {
            updateLayout.mutate({
              reportId: item.i,
              layout: {
                x: item.x,
                y: item.y,
                w: item.w,
                h: item.h,
                minW: item.minW ?? 3,
                minH: item.minH ?? 3,
              },
            });
          }
        }
      });
    },
    [reports, updateLayout]
  );

  const handleResizeStop = useCallback(
    (newLayout: Layout[]) => {
      // Save each changed layout after resize stops
      newLayout.forEach((item) => {
        const report = reports.find((r) => r.id === item.i);
        if (report) {
          const oldLayout = report.layout;
          // Only update if layout actually changed
          if (
            !oldLayout ||
            oldLayout.x !== item.x ||
            oldLayout.y !== item.y ||
            oldLayout.w !== item.w ||
            oldLayout.h !== item.h
          ) {
            updateLayout.mutate({
              reportId: item.i,
              layout: {
                x: item.x,
                y: item.y,
                w: item.w,
                h: item.h,
                minW: item.minW ?? 3,
                minH: item.minH ?? 3,
              },
            });
          }
        }
      });
    },
    [reports, updateLayout]
  );

  if (!dashboard) {
    return null; // Loading handled by suspense
  }

  return (
    <PageContainer fluid>
      <PageHeader
        title={
          <PageBreadcrumbs
            items={[
              {
                label: project?.name ?? projectId,
                to: '/$organizationId/$projectId/dashboards',
                params: {
                  organizationId,
                  projectId,
                },
              },
              {
                label: dashboard.name,
              },
            ]}
          />
        }
        description="View and manage your reports"
        className="mb-4"
        actions={
          <>
            {/* Dashboard time picker removed — each report uses its own range */}
            <LinkButton
              from={Route.fullPath}
              to={'/$organizationId/$projectId/reports'}
              search={{ dashboardId }}
              icon={PlusIcon}
            >
              <span className="max-sm:hidden">Create report</span>
              <span className="sm:hidden">Report</span>
            </LinkButton>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[200px]">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    onClick={() =>
                      pushModal('ShareDashboardModal', { dashboardId })
                    }
                  >
                    <ShareIcon className="mr-2 size-4" />
                    Share dashboard
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      showConfirm({
                        title: 'Reset layout',
                        text: 'Are you sure you want to reset the layout to default? This will clear all custom positioning and sizing.',
                        onConfirm: () =>
                          resetLayout.mutate({ dashboardId, projectId }),
                      })
                    }
                  >
                    <RotateCcw className="mr-2 size-4" />
                    Reset layout
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() =>
                      showConfirm({
                        title: 'Delete dashboard',
                        text: 'Are you sure you want to delete this dashboard? All your reports will be deleted!',
                        onConfirm: () =>
                          dashboardDeletion.mutate({ id: dashboardId }),
                      })
                    }
                  >
                    <TrashIcon className="mr-2 size-4" />
                    Delete dashboard
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
        <span className="px-2 font-medium text-muted-foreground text-sm">
          Dashboard filters
        </span>
        <TimeWindowPicker
          value={dashboardRange}
          onChange={handleDashboardRangeChange}
          startDate={dashboardStartDate}
          endDate={dashboardEndDate}
          onStartDateChange={setDashboardStartDate}
          onEndDateChange={setDashboardEndDate}
          dateConfig={dashboardDateConfig}
          onDateConfigChange={setDashboardDateConfig}
          defaultLabel="Default"
          className="max-w-[240px]"
        />
        {isDashboardFilterDirty && (
          <Button
            onClick={saveDashboardFilters}
            loading={dashboardUpdate.isPending}
            disabled={dashboardUpdate.isPending}
          >
            Update
          </Button>
        )}
        {dashboardRange !== null && (
          <Button variant="ghost" onClick={resetDashboardFilters}>
            Reset to report defaults
          </Button>
        )}
      </div>

      {reports.length === 0 ? (
        <FullPageEmptyState title="No reports" icon={LayoutPanelTopIcon}>
          <p>You can visualize your data with a report</p>
          <LinkButton
            from={Route.fullPath}
            to={'/$organizationId/$projectId/reports'}
            search={{ dashboardId }}
            className="mt-14"
            icon={PlusIcon}
          >
            Create report
          </LinkButton>
        </FullPageEmptyState>
      ) : !isGridReady || reportsQuery.isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ReportItemSkeleton />
          <ReportItemSkeleton />
          <ReportItemSkeleton />
          <ReportItemSkeleton />
          <ReportItemSkeleton />
          <ReportItemSkeleton />
        </div>
      ) : (
        <GrafanaGrid
          transitions={enableTransitions}
          layouts={layouts}
          onLayoutChange={handleLayoutChange}
          onDragStop={handleDragStop}
          onResizeStop={handleResizeStop}
          isDraggable={false}
          isResizable={false}
        >
          {orderedReports.map((report) => {
            const info = rowPositionById.get(report.id);
            return (
              <div key={report.id}>
                <ReportItem
                  report={report}
                  organizationId={organizationId}
                  projectId={projectId}
                  dashboardId={dashboardId}
                  range={dashboardRange}
                  startDate={dashboardStartDate}
                  endDate={dashboardEndDate}
                  interval={null}
                  dateConfig={dashboardDateConfig}
                  onDelete={(reportId) => {
                    reportDeletion.mutate({ reportId });
                  }}
                  onDuplicate={(reportId) => {
                    reportDuplicate.mutate({ reportId });
                  }}
                  onDrop={handleDrop}
                  rowIdx={info?.rowIdx}
                  isFirstInRow={info?.isFirst}
                  isLastInRow={info?.isLast}
                  isRowHovered={
                    info?.rowIdx !== undefined && hoveredRowIdx === info.rowIdx
                  }
                  onAddAt={handleAddAt}
                  onRowHoverChange={handleRowHoverChange}
                />
              </div>
            );
          })}
        </GrafanaGrid>
      )}
    </PageContainer>
  );
}
