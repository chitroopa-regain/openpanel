import type { IChartSerie } from '@openpanel/validation';
import { useQueries } from '@tanstack/react-query';
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
} from 'react';
import { useReportChartContext } from '../context';
import {
  buildBreakdownScreenshotContextBatches,
  buildBreakdownScreenshotTargets,
  EVENT_SCREENSHOT_SIGNED_URL_REFRESH_MS,
  eventScreenshotsForContext,
  MAX_BREAKDOWN_SCREENSHOT_CONTEXTS_PER_QUERY,
  mergeEventScreenshotCatalogs,
} from '@/components/events/event-screenshot-context';
import { EventScreenshotPreview } from '@/components/events/event-screenshot-preview';
import { useTRPC } from '@/integrations/trpc/react';
import type { RouterOutputs } from '@/trpc/client';

interface ScreenshotQuery {
  data?: RouterOutputs['chart']['events'];
  isError: boolean;
  isFetching: boolean;
  isPending: boolean;
  refetch: () => void;
}

interface ScreenshotState {
  catalog: ReturnType<typeof mergeEventScreenshotCatalogs>;
  queries: ScreenshotQuery[];
  targets: ReturnType<typeof buildBreakdownScreenshotTargets>;
}

const ScreenshotContext = createContext<ScreenshotState | null>(null);

export function ReportSeriesScreenshotsProvider({
  chartSeries,
  children,
}: {
  chartSeries: IChartSerie[];
  children: ReactNode;
}) {
  const { report } = useReportChartContext();
  const trpc = useTRPC();
  const targets = useMemo(
    () =>
      buildBreakdownScreenshotTargets({
        chartSeries,
        reportSeries: report.series,
        startDate: report.startDate,
        endDate: report.endDate,
      }),
    [chartSeries, report.endDate, report.series, report.startDate]
  );
  const batches = useMemo(
    () => buildBreakdownScreenshotContextBatches(targets),
    [targets]
  );
  const queries = useQueries({
    queries: batches.map((screenshotContexts) =>
      trpc.chart.events.queryOptions(
        {
          includeDropped: true,
          projectId: report.projectId,
          screenshotContexts,
        },
        {
          enabled: screenshotContexts.length > 0,
          refetchInterval: EVENT_SCREENSHOT_SIGNED_URL_REFRESH_MS,
        }
      )
    ),
  });
  const catalog = mergeEventScreenshotCatalogs(
    queries.map((item) => item.data)
  );

  return (
    <ScreenshotContext.Provider value={{ catalog, queries, targets }}>
      {children}
    </ScreenshotContext.Provider>
  );
}

export function ReportSeriesScreenshot({
  serieId,
  eventName,
  showNoMatch = true,
}: {
  serieId: string;
  eventName: string;
  showNoMatch?: boolean;
}) {
  const state = useContext(ScreenshotContext);
  const refreshedAt = useRef(0);
  if (!state) {
    return null;
  }
  const targetIndex = state.targets.findIndex(
    (target) => target.serieId === serieId
  );
  if (targetIndex < 0) {
    return null;
  }
  const batchIndex = Math.floor(
    targetIndex / MAX_BREAKDOWN_SCREENSHOT_CONTEXTS_PER_QUERY
  );
  const query = state.queries[batchIndex];
  const target = state.targets[targetIndex];
  if (!target || query?.isPending || query?.isError) {
    return null;
  }

  return (
    <EventScreenshotPreview
      compact
      eventName={eventName}
      onImageError={() => {
        const now = Date.now();
        if (!query || query.isFetching || now - refreshedAt.current < 30_000) {
          return;
        }
        refreshedAt.current = now;
        query.refetch();
      }}
      screenshots={eventScreenshotsForContext(state.catalog, target.context)}
      showNoMatch={showNoMatch}
    />
  );
}
