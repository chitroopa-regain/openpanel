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

    // Respect the user's row arrangement: each row renders exactly the cards
    // the user placed in it, filling the full 12-col width by count
    // (1 card → full width, 2 → half each, 3 → thirds, 4 → quarters). Capped
    // at 4 columns of width so a row never makes cards thinner than a quarter.
    // The layout is identical across breakpoints — rows do NOT re-wrap on
    // narrow screens; the grid keeps a min pixel width and scrolls
    // horizontally instead (see GrafanaGrid wrapper).
    const CARD_H = 3; // 3 * rowHeight(100) + margins ≈ 330px
    const layout: ReactGridLayout.Layout[] = [];
    let y = 0;
    rows.forEach((row) => {
      if (row.length === 0) return;
      const w = Math.max(1, Math.floor(12 / Math.min(row.length, 4)));
      row.forEach((id, idx) => {
        layout.push({
          i: id,
          x: idx * w,
          y,
          w,
          h: CARD_H,
          minW: 2,
          minH: 2,
        });
      });
      y += CARD_H;
    });

    // Same layout for every breakpoint — no responsive reflow.
    return {
      xxl: layout,
      xl: layout,
      lg: layout,
      md: layout,
      sm: layout,
      xs: layout,
      xxs: layout,
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
      {/* Horizontal scroll: the grid keeps a minimum width so a row's cards
          never get thinner than ~a quarter of 1040px (~250px). On viewports
          narrower than that the inner grid overflows and scrolls sideways
          instead of re-wrapping cards to the next row. */}
      {/* Keep vertical bleed against the page container's p-4. Add a 28px
        horizontal gutter (px-7) so the floating "+ Add content to row"
        buttons that sit at -left-7 / -right-7 stay fully visible. */}
      <div className="-my-4 px-7 overflow-x-auto">
        <div style={{ minWidth: 1040 }}>
          <ResponsiveGridLayout
            className="layout"
            layouts={layouts}
            // Layout is identical across breakpoints (no responsive reflow),
            // so all cols are 12 and the breakpoints are nominal.
            breakpoints={{
              xxl: 1560,
              xl: 1080,
              lg: 800,
              md: 540,
              sm: 360,
              xs: 200,
              xxs: 0,
            }}
            cols={{ xxl: 12, xl: 12, lg: 12, md: 12, sm: 12, xs: 12, xxs: 12 }}
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
      </div>
    </>
  );
}
