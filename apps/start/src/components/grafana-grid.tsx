import type { IServiceReport } from '@openpanel/db';
import { useMemo } from 'react';
import { Responsive, WidthProvider } from 'react-grid-layout';

const ResponsiveGridLayout = WidthProvider(Responsive);

export type Layout = ReactGridLayout.Layout;

export const useReportLayouts = (
  reports: NonNullable<IServiceReport>[],
): ReactGridLayout.Layouts => {
  return useMemo(() => {
    const baseLayout = reports.map((report, index) => ({
      i: report.id,
      x: report.layout?.x ?? (index % 2) * 6,
      y: report.layout?.y ?? Math.floor(index / 2) * 4,
      w: report.layout?.w ?? 6,
      h: report.layout?.h ?? 4,
      minW: 3,
      minH: 3,
    }));

    // Row-fill repack — tiles share their row's full width.
    // `maxPerRow` caps how many tiles can sit side-by-side; the final row
    // also stretches to fill the row when N is not divisible by maxPerRow.
    // `cols` is the breakpoint's column count (so it works at sm=6, xs=4 etc.).
    const repackPerRow = (maxPerRow: number, cols = 12) => {
      const total = baseLayout.length;
      if (total === 0) return baseLayout;
      const perRow = Math.min(total, maxPerRow);
      const rowCount = Math.ceil(total / perRow);

      // Tallest h per row — every tile in that row is forced to this
      // height so the row reads as a clean horizontal band (Mixpanel-style),
      // instead of zig-zagging when individual tiles have different h.
      const rowH: number[] = [];
      const rowY: number[] = [0];
      for (let r = 0; r < rowCount; r++) {
        const start = r * perRow;
        const end = Math.min(start + perRow, total);
        const maxH = Math.max(
          ...baseLayout.slice(start, end).map((item) => item.h ?? 4),
        );
        rowH.push(maxH);
        rowY.push((rowY[r] ?? 0) + maxH);
      }

      return baseLayout.map((item, index) => {
        const rowIdx = Math.floor(index / perRow);
        const tilesInRow =
          rowIdx === rowCount - 1 ? total - rowIdx * perRow : perRow;
        const w = Math.max(1, Math.floor(cols / tilesInRow));
        const posInRow = index % perRow;
        return {
          ...item,
          w,
          h: rowH[rowIdx] ?? item.h ?? 4,
          x: posInRow * w,
          y: rowY[rowIdx] ?? 0,
        };
      });
    };

    return {
      xxl: repackPerRow(4, 12),
      xl: repackPerRow(4, 12),
      lg: repackPerRow(3, 12),
      md: repackPerRow(2, 12),
      sm: repackPerRow(2, 6),
      xs: repackPerRow(1, 4),
      xxs: repackPerRow(1, 2),
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
