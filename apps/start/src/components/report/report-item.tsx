import { ReportChart } from '@/components/report-chart';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/utils/cn';
import { CopyIcon, MoreHorizontal, Trash } from 'lucide-react';

import { timeWindows } from '@openpanel/constants';

import { useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Mixpanel-style drag-to-reorder. We don't use a drag library — they all
// shift the other cards visually while dragging, which we don't want.
// Instead: native mouse listeners, a portal-rendered ghost that follows
// the cursor, and document.elementsFromPoint on drop to find the target.
//
// Activation threshold (6px) keeps single-clicks from registering as drags.
// Mark the card root with [data-report-item-id], drag handles with
// [data-drag-handle], and the primary handle (whose click navigates) with
// [data-drag-handle-primary].
// Indicator describing where the dragged card will be inserted.
// 'h' (horizontal) → between rows or above-first/below-last.
// 'v' (vertical)   → between cards within a single row.
type Indicator = {
  kind: 'h' | 'v';
  left: number;
  top: number;
  width: number;
  height: number;
};

type LayoutItem = { id: string; rect: DOMRect; index: number };
type LayoutRow = { top: number; bottom: number; items: LayoutItem[] };
type LayoutSnapshot = { items: LayoutItem[]; rows: LayoutRow[] };

function snapshotLayout(): LayoutSnapshot {
  const els = Array.from(
    document.querySelectorAll<HTMLElement>('[data-report-item-id]'),
  );
  // DOM order matches orderedReports order (the parent renders with .map).
  const items: LayoutItem[] = els.map((el, index) => ({
    id: el.dataset.reportItemId ?? '',
    rect: el.getBoundingClientRect(),
    index,
  }));
  // Group items into rows by their `top` value (within tolerance).
  const ROW_TOL = 20;
  const rows: LayoutRow[] = [];
  items.forEach((it) => {
    const row = rows.find((r) => Math.abs(r.top - it.rect.top) < ROW_TOL);
    if (row) {
      row.items.push(it);
      row.top = Math.min(row.top, it.rect.top);
      row.bottom = Math.max(row.bottom, it.rect.bottom);
    } else {
      rows.push({ top: it.rect.top, bottom: it.rect.bottom, items: [it] });
    }
  });
  rows.sort((a, b) => a.top - b.top);
  rows.forEach((r) => r.items.sort((a, b) => a.rect.left - b.rect.left));
  return { items, rows };
}

// Where a drop should land. `newRow` → splice in a brand-new row at
// `rowIdx`; `inRow` → insert into existing row `rowIdx` at column `colIdx`.
export type DropTarget =
  | { kind: 'newRow'; rowIdx: number }
  | { kind: 'inRow'; rowIdx: number; colIdx: number };

// Compute the drop target (and the indicator line) from cursor coords and
// the snapshot of card rects taken at drag start.
function computeSlot(
  cx: number,
  cy: number,
  layout: LayoutSnapshot,
): { target: DropTarget; indicator: Indicator | null } {
  const { rows } = layout;
  if (rows.length === 0) {
    return { target: { kind: 'newRow', rowIdx: 0 }, indicator: null };
  }

  const ROW_GAP_BAND = 24; // generous band around row boundaries
  const firstRow = rows[0]!;
  const lastRow = rows[rows.length - 1]!;
  const fullLeft = Math.min(...rows.map((r) => r.items[0]!.rect.left));
  const fullRight = Math.max(
    ...rows.map((r) => r.items[r.items.length - 1]!.rect.right),
  );

  // 1. Above the first row → new row at top.
  if (cy < firstRow.top + ROW_GAP_BAND) {
    return {
      target: { kind: 'newRow', rowIdx: 0 },
      indicator: {
        kind: 'h',
        left: fullLeft,
        top: Math.max(firstRow.top - 6, 4),
        width: fullRight - fullLeft,
        height: 3,
      },
    };
  }

  // 2. Below the last row → new row at end.
  if (cy > lastRow.bottom - ROW_GAP_BAND) {
    return {
      target: { kind: 'newRow', rowIdx: rows.length },
      indicator: {
        kind: 'h',
        left: fullLeft,
        top: lastRow.bottom + 4,
        width: fullRight - fullLeft,
        height: 3,
      },
    };
  }

  // 3. Between two rows → new row at (i+1).
  for (let i = 0; i < rows.length - 1; i++) {
    const above = rows[i]!;
    const below = rows[i + 1]!;
    if (cy >= above.bottom - ROW_GAP_BAND && cy <= below.top + ROW_GAP_BAND) {
      const mid = (above.bottom + below.top) / 2;
      return {
        target: { kind: 'newRow', rowIdx: i + 1 },
        indicator: {
          kind: 'h',
          left: fullLeft,
          top: mid - 1.5,
          width: fullRight - fullLeft,
          height: 3,
        },
      };
    }
  }

  // 4. Inside a row → find the column-gap nearest the cursor and center the
  // indicator in the actual gap between cards.
  const rowIdx = rows.findIndex(
    (r) => cy >= r.top - 4 && cy <= r.bottom + 4,
  );
  if (rowIdx < 0) {
    return { target: { kind: 'newRow', rowIdx: rows.length }, indicator: null };
  }
  const row = rows[rowIdx]!;
  const FALLBACK_GAP = 16; // visual gap to assume when there's no neighbour card
  const LINE_W = 3;
  for (let i = 0; i < row.items.length; i++) {
    const it = row.items[i]!;
    const center = it.rect.left + it.rect.width / 2;
    if (cx < center) {
      const prevRight =
        i === 0 ? it.rect.left - FALLBACK_GAP : row.items[i - 1]!.rect.right;
      const gapMid = (prevRight + it.rect.left) / 2;
      return {
        target: { kind: 'inRow', rowIdx, colIdx: i },
        indicator: {
          kind: 'v',
          left: gapMid - LINE_W / 2,
          top: row.top,
          width: LINE_W,
          height: row.bottom - row.top,
        },
      };
    }
  }
  const last = row.items[row.items.length - 1]!;
  const afterRight = last.rect.right + FALLBACK_GAP;
  const gapMid = (last.rect.right + afterRight) / 2;
  return {
    target: { kind: 'inRow', rowIdx, colIdx: row.items.length },
    indicator: {
      kind: 'v',
      left: gapMid - LINE_W / 2,
      top: row.top,
      width: LINE_W,
      height: row.bottom - row.top,
    },
  };
}

function useDragReorder({
  reportId,
  onDrop,
  onActivate,
}: {
  reportId: string;
  onDrop: (fromId: string, target: DropTarget) => void;
  onActivate: (event: MouseEvent) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [ghost, setGhost] = useState<{ x: number; y: number; w: number } | null>(null);
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  // Keep latest callbacks in a ref so we don't re-attach listeners every render.
  const cbsRef = useRef({ onDrop, onActivate });
  cbsRef.current = { onDrop, onActivate };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    type DownState = {
      x: number;
      y: number;
      cardRect: DOMRect;
      isDrag: boolean;
      isPrimary: boolean;
      layout: LayoutSnapshot | null;
      target: DropTarget | null;
    };
    let down: DownState | null = null;

    const cleanupCursor = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target || !root.contains(target)) return;
      const handle = target.closest('[data-drag-handle]') as HTMLElement | null;
      if (!handle) return;
      down = {
        x: e.clientX,
        y: e.clientY,
        cardRect: root.getBoundingClientRect(),
        isDrag: false,
        isPrimary: handle.hasAttribute('data-drag-handle-primary'),
        layout: null,
        target: null,
      };
    };

    const onMove = (e: MouseEvent) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (!down.isDrag) {
        if (Math.hypot(dx, dy) <= 6) return;
        down.isDrag = true;
        down.layout = snapshotLayout();
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
        setIsDragging(true);
        setGhost({ x: e.clientX, y: e.clientY, w: down.cardRect.width });
      }
      setGhost((g) => (g ? { ...g, x: e.clientX, y: e.clientY } : g));
      if (down.layout) {
        const { target, indicator: ind } = computeSlot(e.clientX, e.clientY, down.layout);
        down.target = target;
        setIndicator(ind);
      }
      e.preventDefault();
    };

    const onUp = (e: MouseEvent) => {
      const d = down;
      down = null;
      if (!d) return;
      if (d.isDrag) {
        cleanupCursor();
        setIsDragging(false);
        setGhost(null);
        setIndicator(null);
        if (d.target) {
          cbsRef.current.onDrop(reportId, d.target);
        }
      } else if (d.isPrimary) {
        cbsRef.current.onActivate(e);
      }
    };

    const onBlur = () => {
      if (down?.isDrag) {
        cleanupCursor();
        setIsDragging(false);
        setGhost(null);
        setIndicator(null);
      }
      down = null;
    };

    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('blur', onBlur);
      cleanupCursor();
    };
  }, [reportId]);

  return { rootRef, isDragging, ghost, indicator };
}

export function ReportItemSkeleton() {
  return (
    <div className="card h-full flex flex-col animate-pulse">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="flex-1">
          <div className="h-5 w-32 bg-muted rounded mb-2" />
          <div className="h-4 w-24 bg-muted/50 rounded" />
        </div>
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-muted rounded" />
          <div className="w-8 h-8 bg-muted rounded" />
        </div>
      </div>
      <div className="p-4 flex-1 flex items-center justify-center aspect-video" />
    </div>
  );
}

export function ReportItem({
  report,
  organizationId,
  projectId,
  dashboardId,
  range,
  startDate,
  endDate,
  interval,
  onDelete,
  onDuplicate,
  onDrop,
}: {
  report: any;
  organizationId: string;
  projectId: string;
  dashboardId?: string;
  range: any;
  startDate: any;
  endDate: any;
  interval: any;
  onDelete: (reportId: string) => void;
  onDuplicate: (reportId: string) => void;
  onDrop?: (fromId: string, target: DropTarget) => void;
}) {
  const router = useRouter();
  const chartRange = report.range;

  const navigateToReport = (newTab: boolean) => {
    if (newTab) {
      const search = dashboardId
        ? `?dashboardId=${encodeURIComponent(dashboardId)}`
        : '';
      window.open(
        `/${organizationId}/${projectId}/reports/${report.id}${search}`,
        '_blank',
      );
      return;
    }
    router.navigate({
      to: '/$organizationId/$projectId/reports/$reportId',
      params: { organizationId, projectId, reportId: report.id },
      search: dashboardId ? { dashboardId } : undefined,
    });
  };

  const { rootRef, isDragging, ghost, indicator } = useDragReorder({
    reportId: report.id,
    onDrop: onDrop ?? (() => {}),
    onActivate: (e) => navigateToReport(e.metaKey),
  });

  return (
    <div
      ref={rootRef}
      data-report-item-id={report.id}
      className={cn(
        'card h-full flex flex-col',
        // Source card stays visible at original position during drag (Mixpanel
        // behavior). We don't fade it — the ghost makes the drag obvious enough.
        isDragging && 'ring-2 ring-primary/40',
      )}
    >
      <div className="flex items-center hover:bg-muted/50 justify-between border-b border-border p-4 leading-none [&_svg]:hover:opacity-100">
        <div
          data-drag-handle
          data-drag-handle-primary
          className="flex-1 cursor-grab active:cursor-grabbing -m-4 p-4"
          onKeyUp={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              navigateToReport(false);
            }
          }}
          role="button"
          tabIndex={0}
        >
          <div className="font-medium">{report.name}</div>
          {chartRange !== null && (
            <div className="mt-2 flex gap-2 ">
              <span
                className={
                  (chartRange !== range && range !== null) ||
                  (startDate && endDate)
                    ? 'line-through'
                    : ''
                }
              >
                {timeWindows[chartRange as keyof typeof timeWindows]?.label}
              </span>
              {startDate && endDate ? (
                <span>Custom dates</span>
              ) : (
                range !== null &&
                chartRange !== range && (
                  <span>
                    {timeWindows[range as keyof typeof timeWindows]?.label}
                  </span>
                )
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div
            data-drag-handle
            className="cursor-grab active:cursor-grabbing p-2 hover:bg-muted rounded"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="opacity-30 hover:opacity-100"
            >
              <circle cx="4" cy="4" r="1.5" />
              <circle cx="4" cy="8" r="1.5" />
              <circle cx="4" cy="12" r="1.5" />
              <circle cx="12" cy="4" r="1.5" />
              <circle cx="12" cy="8" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
            </svg>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger className="flex h-8 w-8 items-center justify-center rounded hover:border">
              <MoreHorizontal size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[200px]">
              <DropdownMenuItem
                onClick={(event) => {
                  event.stopPropagation();
                  onDuplicate(report.id);
                }}
              >
                <CopyIcon size={16} className="mr-2" />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuGroup>
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(report.id);
                  }}
                >
                  <Trash size={16} className="mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div
        className={cn(
          'p-4 overflow-auto flex-1',
          report.chartType === 'metric' && 'p-0',
        )}
      >
        <ReportChart
          report={{
            ...report,
            range: range ?? report.range,
            startDate: startDate ?? null,
            endDate: endDate ?? null,
            interval: interval ?? report.interval,
          }}
          options={{
            showFunnelPreviewLabels: report.chartType === 'funnel',
            metricLayout:
              report.chartType === 'metric' && report.breakdowns.length === 0
                ? 'hero'
                : 'compact',
            metricSurface:
              report.chartType === 'metric' ? 'plain' : 'card',
          }}
        />
      </div>
      {isDragging && typeof document !== 'undefined'
        ? createPortal(
            <>
              {indicator && (
                <div
                  className="fixed z-[999] pointer-events-none rounded-full bg-foreground/35"
                  style={{
                    left: indicator.left,
                    top: indicator.top,
                    width: indicator.width,
                    height: indicator.height,
                  }}
                />
              )}
              {ghost && (
                <div
                  className="fixed z-[1000] pointer-events-none"
                  style={{
                    left: ghost.x + 14,
                    top: ghost.y + 14,
                    width: Math.min(ghost.w * 0.55, 360),
                  }}
                >
                  <div className="card border-2 border-primary/60 bg-card/95 backdrop-blur-sm shadow-2xl rounded-lg px-4 py-3">
                    <div className="font-medium truncate">{report.name}</div>
                    {chartRange !== null && (
                      <div className="mt-1 text-xs text-muted-foreground truncate">
                        {timeWindows[chartRange as keyof typeof timeWindows]?.label}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>,
            document.body,
          )
        : null}
    </div>
  );
}

export function ReportItemReadOnly({
  report,
  shareId,
  range,
  startDate,
  endDate,
  interval,
}: {
  report: any;
  shareId: string;
  range: any;
  startDate: any;
  endDate: any;
  interval: any;
}) {
  const chartRange = report.range;

  return (
    <div className="card h-full flex flex-col">
      <div className="flex items-center justify-between border-b border-border p-4 leading-none">
        <div className="flex-1">
          <div className="font-medium">{report.name}</div>
          {chartRange !== null && (
            <div className="mt-2 flex gap-2 ">
              <span
                className={
                  (chartRange !== range && range !== null) ||
                  (startDate && endDate)
                    ? 'line-through'
                    : ''
                }
              >
                {timeWindows[chartRange as keyof typeof timeWindows]?.label}
              </span>
              {startDate && endDate ? (
                <span>Custom dates</span>
              ) : (
                range !== null &&
                chartRange !== range && (
                  <span>
                    {timeWindows[range as keyof typeof timeWindows]?.label}
                  </span>
                )
              )}
            </div>
          )}
        </div>
      </div>
      <div
        className={cn(
          'p-4 overflow-auto flex-1',
          report.chartType === 'metric' && 'p-0',
        )}
      >
        <ReportChart
          report={{
            ...report,
            range: range ?? report.range,
            startDate: startDate ?? null,
            endDate: endDate ?? null,
            interval: interval ?? report.interval,
          }}
          options={{
            showFunnelPreviewLabels: report.chartType === 'funnel',
            metricLayout:
              report.chartType === 'metric' && report.breakdowns.length === 0
                ? 'hero'
                : 'compact',
            metricSurface:
              report.chartType === 'metric' ? 'plain' : 'card',
          }}
          shareId={shareId}
        />
      </div>
    </div>
  );
}
