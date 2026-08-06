import type { IReportInput } from '@openpanel/validation';
import { useReportChartContext } from './context';

export type ReportDisplayMode = 'both' | 'chart' | 'table';

export function getReportDisplayMode(
  report: Pick<IReportInput, 'options'>,
  layout: 'default' | 'dashboard' = 'default'
): ReportDisplayMode {
  return (
    report.options?.displayMode ?? (layout === 'dashboard' ? 'chart' : 'both')
  );
}

export function getReportDisplayVisibility(mode: ReportDisplayMode) {
  return {
    showChart: mode !== 'table',
    showTable: mode !== 'chart',
  };
}

export function useReportDisplayVisibility() {
  const { report, options } = useReportChartContext();
  return getReportDisplayVisibility(
    getReportDisplayMode(report, options.displayLayout ?? 'default')
  );
}
