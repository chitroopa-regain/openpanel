import type { IChartSerie, IReportInput } from '@openpanel/validation';
import isEqual from 'lodash.isequal';
import type { LucideIcon } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

export type ReportChartContextType = {
  options: Partial<{
    columns: React.ReactNode[];
    hideLegend: boolean;
    hideXAxis: boolean;
    hideYAxis: boolean;
    showFunnelPreviewLabels: boolean;
    funnelLayout: 'default' | 'dashboard';
    retentionLayout: 'default' | 'dashboard';
    metricLayout: 'compact' | 'hero';
    metricSurface: 'card' | 'plain';
    aspectRatio: number;
    maxHeight: number;
    minHeight: number;
    maxDomain: number;
    onClick: (serie: IChartSerie) => void;
    renderSerieName: (names: string[]) => React.ReactNode;
    renderSerieIcon: (serie: IChartSerie) => React.ReactNode;
    dropdownMenuContent: (serie: IChartSerie) => {
      icon: LucideIcon;
      title: string;
      onClick: () => void;
    }[];
  }>;
  report: IReportInput & { id?: string };
  isLazyLoading: boolean;
  isEditMode: boolean;
  shareId?: string;
  reportId?: string;
};

// Cache age + revalidation state, surfaced by the active chart leaf's data hook
// and consumed by <ReportCacheStatus> ("Updated X ago" + refresh button).
export type ReportCacheStatus = {
  cachedAt: number | null;
  isRevalidating: boolean;
};

type ReportChartContextValue = ReportChartContextType & {
  cacheStatus: ReportCacheStatus;
  setCacheStatus: (status: ReportCacheStatus) => void;
  registerRefresh: (fn: (() => void) | null) => void;
  refresh: () => void;
};

type ReportChartContextProviderProps = ReportChartContextType & {
  children: React.ReactNode;
};

export type ReportChartProps = Partial<ReportChartContextType> & {
  report: IReportInput & { id?: string };
  lazy?: boolean;
};

const context = createContext<ReportChartContextValue | null>(null);

export const useReportChartContext = () => {
  const ctx = useContext(context);
  if (!ctx) {
    throw new Error(
      'useReportChartContext must be used within a ReportChartProvider'
    );
  }
  return ctx;
};

export const ReportChartProvider = ({
  children,
  ...propsToContext
}: ReportChartContextProviderProps) => {
  const [ctx, setContext] = useState(propsToContext);

  useEffect(() => {
    if (!isEqual(ctx, propsToContext)) {
      setContext(propsToContext);
    }
  }, [propsToContext]);

  const [cacheStatus, setCacheStatus] = useState<ReportCacheStatus>({
    cachedAt: null,
    isRevalidating: false,
  });

  // The refresh handler is owned by the active leaf's data hook; keep it in a
  // ref so registering it doesn't re-render, and expose a stable trigger.
  const refreshRef = useRef<(() => void) | null>(null);
  const registerRefresh = useCallback((fn: (() => void) | null) => {
    refreshRef.current = fn;
  }, []);
  const refresh = useCallback(() => {
    refreshRef.current?.();
  }, []);

  const value = useMemo<ReportChartContextValue>(
    () => ({ ...ctx, cacheStatus, setCacheStatus, registerRefresh, refresh }),
    [ctx, cacheStatus, registerRefresh, refresh]
  );

  return <context.Provider value={value}>{children}</context.Provider>;
};

export default context;
