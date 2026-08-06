import { mergeDeepRight } from 'ramda';
import { type RefObject, useEffect, useRef } from 'react';
import { useInViewport } from 'react-in-viewport';
import { ReportAreaChart } from './area';
import { ReportBarChart } from './bar';
import type { ReportChartProps } from './context';
import { ReportChartProvider } from './context';
import { ReportConversionChart } from './conversion';
import { ReportFunnelChart } from './funnel';
import { ReportFunnelMetricChart } from './funnel-metric';
import { ReportHistogramChart } from './histogram';
import { ReportLineChart } from './line';
import { ReportMapChart } from './map';
import { ReportMetricChart } from './metric';
import { ReportPieChart } from './pie';
import { ReportRetentionChart } from './retention';
import { ReportSankeyChart } from './sankey';
import { ReportTableChart } from './table';
import { cn } from '@/utils/cn';

export const ReportChart = ({ lazy = true, ...props }: ReportChartProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const once = useRef(false);
  const { inViewport } = useInViewport(
    ref as RefObject<HTMLElement>,
    undefined,
    {
      disconnectOnLeave: true,
    }
  );

  useEffect(() => {
    if (inViewport) {
      once.current = true;
    }
  }, [inViewport]);

  const loaded = lazy ? once.current || inViewport : true;
  const isDashboardBoth =
    props.options?.displayLayout === 'dashboard' &&
    props.report.options?.displayMode === 'both';

  const renderReportChart = () => {
    switch (props.report.chartType) {
      case 'linear':
        return <ReportLineChart />;
      case 'bar':
        return <ReportBarChart />;
      case 'area':
        return <ReportAreaChart />;
      case 'histogram':
        return <ReportHistogramChart />;
      case 'pie':
        return <ReportPieChart />;
      case 'map':
        return <ReportMapChart />;
      case 'metric':
        return <ReportMetricChart />;
      case 'funnel':
        return <ReportFunnelChart />;
      case 'funnel_metric':
        return <ReportFunnelMetricChart />;
      case 'retention':
        return <ReportRetentionChart />;
      case 'conversion':
        return <ReportConversionChart />;
      case 'sankey':
        return <ReportSankeyChart />;
      case 'table':
        return <ReportTableChart />;
      default:
        return null;
    }
  };

  return (
    <div
      className={cn(
        'h-full w-full',
        isDashboardBoth && 'overflow-y-auto overscroll-contain'
      )}
      ref={ref}
    >
      <ReportChartProvider
        {...mergeDeepRight({ options: {}, isEditMode: false }, props)}
        isLazyLoading={!loaded}
      >
        {renderReportChart()}
      </ReportChartProvider>
    </div>
  );
};
