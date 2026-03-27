import { ReportChart } from '@/components/report-chart';
import { ReportChartType } from '@/components/report/ReportChartType';
import { ReportInterval } from '@/components/report/ReportInterval';
import { ReportLineType } from '@/components/report/ReportLineType';
import { ReportSaveButton } from '@/components/report/ReportSaveButton';
import {
  changeChartType,
  changeDateRanges,
  changeEndDate,
  changeInterval,
  changeStartDate,
  ready,
  reset,
  setReport,
} from '@/components/report/reportSlice';
import { ReportSidebar } from '@/components/report/sidebar/ReportSidebar';
import { TimeWindowPicker } from '@/components/time-window-picker';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { useAppParams } from '@/hooks/use-app-params';
import { pushModal } from '@/modals';
import { useDispatch, useSelector } from '@/redux';
import { bind } from 'bind-event-listener';
import { CodeIcon, GanttChartSquareIcon, ShareIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { IServiceReport } from '@openpanel/db';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useTRPC } from '@/integrations/trpc/react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import EditReportName from '../report/edit-report-name';

function ShowQueryButton() {
  const report = useSelector((state) => state.report);
  const { projectId } = useAppParams();
  const trpc = useTRPC();
  const [open, setOpen] = useState(false);

  const input = { ...report, projectId };
  const queryOpts = {
    enabled: open && report.ready,
    staleTime: 1000 * 60,
    retry: false,
  };
  const chartType = report.chartType;
  const firstSeriesItem = report.series[0];
  const secondSeriesItem = report.series[1];
  const firstRetentionEvent =
    firstSeriesItem?.type === 'event'
      ? (firstSeriesItem.filters?.[0]?.value ?? []).map(String)
      : [];
  const firstRetentionCustomEventId =
    firstSeriesItem?.type === 'custom_event'
      ? firstSeriesItem.customEventId
      : undefined;
  const secondRetentionEvent =
    secondSeriesItem?.type === 'event'
      ? (secondSeriesItem.filters?.[0]?.value ?? []).map(String)
      : [];
  const secondRetentionCustomEventId =
    secondSeriesItem?.type === 'custom_event'
      ? secondSeriesItem.customEventId
      : undefined;
  const firstRetentionFilters =
    firstSeriesItem?.type === 'event'
      ? (firstSeriesItem.filters ?? []).slice(1)
      : firstSeriesItem?.type === 'custom_event'
        ? (firstSeriesItem.filters ?? [])
        : [];
  const secondRetentionFilters =
    secondSeriesItem?.type === 'event'
      ? (secondSeriesItem.filters ?? []).slice(1)
      : secondSeriesItem?.type === 'custom_event'
        ? (secondSeriesItem.filters ?? [])
        : [];
  const retentionOptions =
    report.options?.type === 'retention' ? report.options : undefined;

  const chartRes = useQuery(
    trpc.chart.chart.queryOptions(input, {
      ...queryOpts,
      enabled:
        queryOpts.enabled &&
        !['bar', 'pie', 'funnel', 'retention', 'conversion', 'sankey'].includes(
          chartType,
        ),
    }),
  );
  const aggregateRes = useQuery(
    trpc.chart.aggregate.queryOptions(input, {
      ...queryOpts,
      enabled: queryOpts.enabled && ['bar', 'pie'].includes(chartType),
    }),
  );
  const funnelRes = useQuery(
    trpc.chart.funnel.queryOptions(input, {
      ...queryOpts,
      enabled: queryOpts.enabled && chartType === 'funnel',
    }),
  );
  const cohortRes = useQuery(
    trpc.chart.cohort.queryOptions(
      {
        projectId,
        firstEvent: firstRetentionEvent,
        secondEvent: secondRetentionEvent,
        firstCustomEventId: firstRetentionCustomEventId,
        secondCustomEventId: secondRetentionCustomEventId,
        firstEventFilters: firstRetentionFilters,
        secondEventFilters: secondRetentionFilters,
        range: report.range,
        startDate: report.startDate,
        endDate: report.endDate,
        criteria: retentionOptions?.criteria,
        interval: report.interval,
        id: 'id' in report ? report.id : undefined,
      },
      {
        ...queryOpts,
        enabled:
          queryOpts.enabled &&
          chartType === 'retention' &&
          (firstRetentionEvent.length > 0 ||
            !!firstRetentionCustomEventId) &&
          (secondRetentionEvent.length > 0 ||
            !!secondRetentionCustomEventId),
      },
    ),
  );
  const conversionRes = useQuery(
    trpc.chart.conversion.queryOptions(input, {
      ...queryOpts,
      enabled: queryOpts.enabled && chartType === 'conversion',
    }),
  );
  const sankeyRes = useQuery(
    trpc.chart.sankey.queryOptions(input, {
      ...queryOpts,
      enabled: queryOpts.enabled && chartType === 'sankey',
    }),
  );

  const res =
    chartType === 'bar' || chartType === 'pie'
      ? aggregateRes
      : chartType === 'funnel'
        ? funnelRes
        : chartType === 'retention'
          ? cohortRes
          : chartType === 'conversion'
            ? conversionRes
            : chartType === 'sankey'
              ? sankeyRes
              : chartRes;
  const queries = res.data?.queries ?? [];
  const timezone = res.data?.timezone ?? 'UTC';

  useEffect(() => {
    if (!open) return;
    void res.refetch();
  }, [open, chartType, res.refetch]);

  const toPlayQuery = useCallback(
    (sql: string) => {
      const tables = [
        'events',
        'sessions',
        'profiles',
        'profile_aliases',
        'events_bots',
        'cohort_events_mv',
        'dau_mv',
        'distinct_event_names_mv',
        'event_property_values_mv',
        'session_replay_chunks',
        'events_imports',
      ];
      const pattern = new RegExp(
        `\\b(FROM|JOIN)\\s+(${tables.join('|')})\\b`,
        'gi',
      );
      const withDb = sql.replace(pattern, '$1 openpanel.$2');
      return `${withDb}\nSETTINGS session_timezone = '${timezone}'`;
    },
    [timezone],
  );

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(queries.join('\n\n'));
    toast('Copied to clipboard');
  }, [queries]);

  const handleCopyForPlay = useCallback(() => {
    navigator.clipboard.writeText(
      queries.map(toPlayQuery).join('\n\n'),
    );
    toast('Copied for ClickHouse Play');
  }, [queries, toPlayQuery]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" icon={CodeIcon}>
          Query
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>ClickHouse Query</DialogTitle>
          <DialogDescription>
            Inspect the SQL generated for the current chart and copy it for
            ClickHouse Play if needed.
          </DialogDescription>
        </DialogHeader>
        {res.isLoading ? (
          <div className="p-4 text-muted-foreground">Loading...</div>
        ) : res.isError ? (
          <div className="p-4 text-destructive">
            Failed to load queries
            {'message' in res.error && res.error.message
              ? `: ${res.error.message}`
              : ''}
          </div>
        ) : queries.length === 0 ? (
          <div className="p-4 text-muted-foreground">No queries available</div>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleCopy}>
                Copy
              </Button>
              <Button variant="outline" size="sm" onClick={handleCopyForPlay}>
                Copy for CH Play
              </Button>
            </div>
            {queries.map((sql, i) => (
              <pre
                key={i}
                className="rounded bg-muted p-4 text-xs overflow-x-auto whitespace-pre-wrap font-mono"
              >
                {sql}
              </pre>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ReportEditorProps {
  report: IServiceReport | null;
}

export default function ReportEditor({
  report: initialReport,
}: ReportEditorProps) {
  const { projectId } = useAppParams();
  const dispatch = useDispatch();
  const report = useSelector((state) => state.report);

  // Set report if reportId exists
  useEffect(() => {
    if (initialReport) {
      dispatch(setReport(initialReport));
    } else {
      dispatch(ready());
    }

    return () => {
      dispatch(reset());
    };
  }, [initialReport, dispatch]);

  return (
    <Sheet>
      <div>
        <div className="p-4 flex items-center justify-between">
          <EditReportName />
          {initialReport?.id && (
            <Button
              variant="outline"
              icon={ShareIcon}
              onClick={() =>
                pushModal('ShareReportModal', { reportId: initialReport.id })
              }
            >
              Share
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 p-4 pt-0 md:grid-cols-6">
          <SheetTrigger asChild>
            <Button
              icon={GanttChartSquareIcon}
              variant="cta"
              className="self-start"
            >
              Pick events
            </Button>
          </SheetTrigger>
          <div className="col-span-4 grid grid-cols-2 gap-2 md:grid-cols-4">
            <ReportChartType
              className="min-w-0 flex-1"
              onChange={(type) => {
                dispatch(changeChartType(type));
              }}
              value={report.chartType}
            />
            <TimeWindowPicker
              className="min-w-0 flex-1"
              onChange={(value) => {
                dispatch(changeDateRanges(value));
              }}
              value={report.range}
              onStartDateChange={(date) => dispatch(changeStartDate(date))}
              onEndDateChange={(date) => dispatch(changeEndDate(date))}
              endDate={report.endDate}
              startDate={report.startDate}
            />
            <ReportInterval
              className="min-w-0 flex-1"
              interval={report.interval}
              onChange={(newInterval) => dispatch(changeInterval(newInterval))}
              range={report.range}
              chartType={report.chartType}
              startDate={report.startDate}
              endDate={report.endDate}
            />
            <ReportLineType className="min-w-0 flex-1" />
          </div>
          <div className="col-start-2 row-start-1 flex items-center justify-end gap-2 md:col-start-6">
            <ShowQueryButton />
            <ReportSaveButton />
          </div>
        </div>
        <div className="flex flex-col gap-4 p-4" id="report-editor">
          {report.ready && (
            <ReportChart report={{ ...report, projectId }} isEditMode />
          )}
        </div>
      </div>
      <SheetContent className="!max-w-lg" side="left">
        <ReportSidebar />
      </SheetContent>
    </Sheet>
  );
}
