import type { IServiceReport } from '@openpanel/db';
import { useMemo } from 'react';
import { Responsive, WidthProvider } from 'react-grid-layout';

const ResponsiveGridLayout = WidthProvider(Responsive);

export type Layout = ReactGridLayout.Layout;

// Group reports into logical rows based on `layout.y`. Cards that share the
// same `y` belong to the same row; the row's order on screen comes from the
// sorted distinct y values. Cards without a saved layout get packed 4-per-row
// into trailing rows so freshly-created reports still render reasonably.
//
// Legacy state: if every card has a unique y (meaning no row sharing exists
// in the data — which happens when an older flat-index persistence model
// wrote y = arrayIndex), fall back to a default 4-per-row pack of the
// already-sorted reports. The user can then drag to create row breaks.
export function deriveRowsFromReports(
  reports: NonNullable<IServiceReport>[],
): string[][] {
  if (reports.length === 0) return [];

  const ys = reports
    .map((r) => (r as any).layout?.y)
    .filter((y): y is number => typeof y === 'number');
  const uniqueYs = new Set(ys);
  const allUnique = ys.length === reports.length && uniqueYs.size === reports.length;

  if (allUnique) {
    // Treat as "no row info" — pack into default 4-per-row chunks. Reports
    // are already sorted by (y, x) by the server, so we use that order.
    const rows: string[][] = [];
    for (let i = 0; i < reports.length; i += 4) {
      rows.push(reports.slice(i, i + 4).map((r) => r.id));
    }
    return rows;
  }

  const groupY = new Map<number, { id: string; x: number }[]>();
  let pendingY = 1_000_000;
  let pendingCount = 0;
  reports.forEach((r) => {
    const layout = (r as any).layout;
    let y: number;
    if (typeof layout?.y === 'number') {
      y = layout.y;
    } else {
      y = pendingY + Math.floor(pendingCount / 4);
      pendingCount++;
    }
    if (!groupY.has(y)) groupY.set(y, []);
    groupY.get(y)!.push({ id: r.id, x: layout?.x ?? 0 });
  });
  const sortedYs = Array.from(groupY.keys()).sort((a, b) => a - b);
  return sortedYs.map((y) =>
    groupY
      .get(y)!
      .sort((a, b) => a.x - b.x)
      .map((it) => it.id),
  );
}

export const useReportLayouts = (
  reports: NonNullable<IServiceReport>[],
): ReactGridLayout.Layouts => {
  return useMemo(() => {
    const rows = deriveRowsFromReports(reports);
    const byId = new Map(reports.map((r) => [r.id, r] as const));

    // For each breakpoint, walk through user-defined rows and place them at
    // the next y-cursor. If a row has more items than `maxPerRow` for this
    // breakpoint, wrap it into sub-rows. Otherwise the row is rendered
    // exactly as the user defined it (so a 1-card row spans the full width,
    // a 2-card row splits in half, etc.).
    const compute = (
      maxPerRow: number,
      cols: number,
    ): ReactGridLayout.Layout[] => {
      const out: ReactGridLayout.Layout[] = [];
      let yCursor = 0;
      rows.forEach((row) => {
        if (row.length === 0) return;
        for (let i = 0; i < row.length; i += maxPerRow) {
          const chunk = row.slice(i, i + maxPerRow);
          const w = Math.max(1, Math.floor(cols / chunk.length));
          const maxH = Math.max(
            ...chunk.map((id) => (byId.get(id) as any)?.layout?.h ?? 4),
            4,
          );
          chunk.forEach((id, posInChunk) => {
            out.push({
              i: id,
              x: posInChunk * w,
              y: yCursor,
              w,
              h: maxH,
              minW: 3,
              minH: 3,
            });
          });
          yCursor += maxH;
        }
      });
      return out;
    };

    return {
      xxl: compute(4, 12),
      xl: compute(4, 12),
      lg: compute(3, 12),
      md: compute(2, 12),
      sm: compute(2, 6),
      xs: compute(1, 4),
      xxs: compute(1, 2),
    };
  }, [reports]);
};

export function GrafanaGrid({
  layouts,
  children,
  transitions,
  onLayoutChange,
  onDragStop,
  onResizeStop,
  isDraggable,
  isResizable,
}: {
  children: React.ReactNode;
  transitions?: boolean;
} & Pick<
  ReactGridLayout.ResponsiveProps,
  | 'layouts'
  | 'onLayoutChange'
  | 'onDragStop'
  | 'onResizeStop'
  | 'isDraggable'
  | 'isResizable'
>) {
  return (
    <>
      <style>{`
        .react-grid-item {
          transition: ${transitions ? 'transform 200ms ease, width 200ms ease, height 200ms ease' : 'none'} !important;
        }
        .react-grid-item.react-grid-placeholder {
          background: none !important;
          opacity: 0.5;
          transition-duration: 100ms;
          border-radius: 0.5rem;
          border: 1px dashed var(--primary);
        }
        .react-grid-item.resizing {
          transition: none !important;
        }
      `}</style>
      <div className="-m-4">
        <ResponsiveGridLayout
          className="layout"
          layouts={layouts}
          breakpoints={{
            xxl: 1920,
            xl: 1500,
            lg: 1200,
            md: 996,
            sm: 768,
            xs: 480,
            xxs: 0,
          }}
          cols={{ xxl: 12, xl: 12, lg: 12, md: 12, sm: 6, xs: 4, xxs: 2 }}
          rowHeight={100}
          draggableHandle=".drag-handle"
          compactType="vertical"
          preventCollision={false}
          margin={[16, 16]}
          transformScale={1}
          useCSSTransforms={true}
          onLayoutChange={onLayoutChange}
          onDragStop={onDragStop}
          onResizeStop={onResizeStop}
          isDraggable={isDraggable}
          isResizable={isResizable}
        >
          {children}
        </ResponsiveGridLayout>
      </div>
    </>
  );
}
