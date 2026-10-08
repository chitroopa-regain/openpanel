// Dashboard layout h is measured in 100px rows with 16px gaps. All legacy
// heights were ignored (production contains h=2..16, not just h=4).
// A bounded maxH marks an explicit selection made by the height control;
// existing layouts have maxH=null and retain their original visual default.
export const REPORT_HEIGHTS = [3, 6, 9, 12] as const;

type HeightReport = {
  dashboardId?: string | null;
  layout?: {
    h?: number;
    x?: number;
    y?: number;
    w?: number;
    maxH?: number | null;
  } | null;
};

export function getDefaultReportHeight(report: HeightReport) {
  return report.dashboardId === 'top-level-app-metrics' ? 6 : 3;
}

export function getReportHeight(report: HeightReport) {
  const fallback = getDefaultReportHeight(report);
  const h = report.layout?.h;
  if (report.layout?.maxH !== 12 || h == null || !Number.isFinite(h) || h < 3)
    return fallback;
  // Top-level app metrics historically rendered at 6 even with stored h=3.
  return Math.min(12, Math.max(fallback, Math.round(h)));
}

export function getReportChartHeights(report: HeightReport) {
  const isTopLevel = report.dashboardId === 'top-level-app-metrics';
  const extra =
    (getReportHeight(report) - getDefaultReportHeight(report)) * 116;
  return {
    maxHeight: (isTopLevel ? 600 : 300) + extra,
    minHeight: isTopLevel ? 400 : 100,
  };
}

export function prepareReportHeightChange<
  T extends HeightReport & { id: string },
>(reports: T[], rows: string[][], reportId: string, height: number) {
  const target = reports.find((report) => report.id === reportId);
  if (!target || !REPORT_HEIGHTS.some((h) => h === height)) return reports;
  // Materialize row memberships together for unsaved cards. Otherwise their
  // unsaved siblings move to trailing rows on reload, changing widths.
  const materializeRows = !target.layout;
  return reports.map((report) => {
    if (!materializeRows && report.id !== reportId) return report;
    const rowIdx = rows.findIndex((row) => row.includes(report.id));
    if (rowIdx < 0) return report;
    const colIdx = rows[rowIdx]!.indexOf(report.id);
    const next = withReportHeight(
      report,
      report.id === reportId ? height : getReportHeight(report),
      rowIdx,
      colIdx
    );
    if (materializeRows) {
      next.layout.x = colIdx;
      next.layout.y = rowIdx;
    }
    return next;
  });
}

// Do not serialize pixel/grid x/y back into the logical row model. Only h
// changes for existing layouts; missing layouts use the currently visible slot.
export function withReportHeight<T extends HeightReport & { id: string }>(
  report: T,
  h: number,
  rowIdx: number,
  colIdx: number
) {
  return {
    ...report,
    layout: {
      x: colIdx,
      y: rowIdx,
      w: 6,
      minW: 2,
      minH: 2,
      ...report.layout,
      h,
      maxH: 12,
    },
  };
}
