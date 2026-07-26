import type { IServiceReport } from '@openpanel/db';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter, useSearch } from '@tanstack/react-router';
import {
  CodeIcon,
  GanttChartSquareIcon,
  Settings2Icon,
  ShareIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import EditReportName from '../report/edit-report-name';
import { ReportCacheBadge } from './report-cache-status';
import {
  type BreadcrumbItem,
  PageBreadcrumbs,
} from '@/components/page-breadcrumbs';
import { ReportChartType } from '@/components/report/ReportChartType';
import { ReportInterval } from '@/components/report/ReportInterval';
import { ReportLineType } from '@/components/report/ReportLineType';
import { ReportSaveButton } from '@/components/report/ReportSaveButton';
import {
  changeChartType,
  changeDateConfig,
  changeDateRanges,
  changeEndDate,
  changeInterval,
  changeStartDate,
  hydrateDraftReport,
  ready,
  reset,
  resetDirty,
  setReport,
} from '@/components/report/reportSlice';
import { ReportSidebar } from '@/components/report/sidebar/ReportSidebar';
import { ReportChart } from '@/components/report-chart';
import {
  clearReportDraft,
  createReportDraftToken,
  loadReportDraft,
  saveReportDraft,
} from '@/components/report-chart/report-draft';
import { TimeWindowPicker } from '@/components/time-window-picker';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAppParams } from '@/hooks/use-app-params';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import { handleError, useTRPC } from '@/integrations/trpc/react';
import { pushModal } from '@/modals';
import { useDispatch, useSelector } from '@/redux';

function ReportSqlContent({ active }: { active: boolean }) {
  const report = useSelector((state) => state.report);
  const { projectId } = useAppParams();
  const trpc = useTRPC();

  const input = { ...report, projectId };
  const queryOpts = {
    enabled: active && report.ready,
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
  const firstRetentionFirstTimeFilter =
    firstSeriesItem?.type === 'event' ||
    firstSeriesItem?.type === 'custom_event'
      ? !!firstSeriesItem.firstTimeFilter
      : false;
  const secondRetentionFirstTimeFilter =
    secondSeriesItem?.type === 'event' ||
    secondSeriesItem?.type === 'custom_event'
      ? !!secondSeriesItem.firstTimeFilter
      : false;
  const retentionOptions =
    report.options?.type === 'retention' ? report.options : undefined;
  const propertyAverageDenominatorStep =
    retentionOptions?.propertyAverageDenominatorStep;

  const chartRes = useQuery(
    trpc.chart.chart.queryOptions(input, {
      ...queryOpts,
      enabled:
        queryOpts.enabled &&
        ![
          'bar',
          'pie',
          'table',
          'funnel',
          'funnel_metric',
          'retention',
          'conversion',
          'sankey',
        ].includes(chartType),
    })
  );
  const aggregateRes = useQuery(
    trpc.chart.aggregate.queryOptions(input, {
      ...queryOpts,
      enabled: queryOpts.enabled && ['bar', 'pie', 'table'].includes(chartType),
    })
  );
  const funnelRes = useQuery(
    trpc.chart.funnel.queryOptions(input, {
      ...queryOpts,
      enabled:
        queryOpts.enabled &&
        (chartType === 'funnel' || chartType === 'funnel_metric'),
    })
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
        firstEventFirstTimeFilter: firstRetentionFirstTimeFilter,
        secondEventFirstTimeFilter: secondRetentionFirstTimeFilter,
        range: report.range,
        startDate: report.startDate,
        endDate: report.endDate,
        dateConfig: report.dateConfig,
        criteria: retentionOptions?.criteria,
        metric: retentionOptions?.metric,
        property: retentionOptions?.property,
        propertyAverageDenominatorStep,
        retentionUnit: retentionOptions?.retentionUnit,
        breakdowns: report.breakdowns,
        interval: report.interval,
        id: 'id' in report ? report.id : undefined,
      },
      {
        ...queryOpts,
        enabled:
          queryOpts.enabled &&
          chartType === 'retention' &&
          (firstRetentionEvent.length > 0 || !!firstRetentionCustomEventId) &&
          (secondRetentionEvent.length > 0 || !!secondRetentionCustomEventId),
      }
    )
  );
  const conversionRes = useQuery(
    trpc.chart.conversion.queryOptions(input, {
      ...queryOpts,
      enabled: queryOpts.enabled && chartType === 'conversion',
    })
  );
  const sankeyRes = useQuery(
    trpc.chart.sankey.queryOptions(input, {
      ...queryOpts,
      enabled: queryOpts.enabled && chartType === 'sankey',
    })
  );

  const res =
    chartType === 'bar' || chartType === 'pie' || chartType === 'table'
      ? aggregateRes
      : chartType === 'funnel' || chartType === 'funnel_metric'
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
    if (!active) {
      return;
    }
    void res.refetch();
  }, [active, chartType, res.refetch]);

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
        'gi'
      );
      const withDb = sql.replace(pattern, '$1 openpanel.$2');
      return `${withDb}\nSETTINGS session_timezone = '${timezone}'`;
    },
    [timezone]
  );

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(queries.join('\n\n'));
    toast('Copied to clipboard');
  }, [queries]);

  const handleCopyForPlay = useCallback(() => {
    navigator.clipboard.writeText(queries.map(toPlayQuery).join('\n\n'));
    toast('Copied for ClickHouse Play');
  }, [queries, toPlayQuery]);

  return (
    <>
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
            <Button onClick={handleCopy} size="sm" variant="outline">
              Copy
            </Button>
            <Button onClick={handleCopyForPlay} size="sm" variant="outline">
              Copy for CH Play
            </Button>
          </div>
          {queries.map((sql, i) => (
            <pre
              className="overflow-x-auto whitespace-pre-wrap rounded bg-muted p-4 font-mono text-xs"
              key={i}
            >
              {sql}
            </pre>
          ))}
        </div>
      )}
    </>
  );
}

function ReportInspector() {
  const [tab, setTab] = useState<'query' | 'sql'>('query');

  return (
    <aside className="hidden lg:flex lg:w-[22rem] lg:shrink-0 lg:flex-col lg:rounded-xl lg:border lg:bg-card">
      <Tabs
        className="flex h-full min-h-0 flex-col"
        onValueChange={(value) => setTab(value as 'query' | 'sql')}
        value={tab}
      >
        <div className="border-b px-4 pt-4">
          <TabsList>
            <TabsTrigger className="gap-2" value="query">
              <Settings2Icon className="h-4 w-4" />
              Query
            </TabsTrigger>
            <TabsTrigger className="gap-2" value="sql">
              <CodeIcon className="h-4 w-4" />
              SQL
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent
          className="mt-0 min-h-0 flex-1 overflow-y-auto p-4"
          value="query"
        >
          <ReportSidebar showFooter={false} />
        </TabsContent>
        <TabsContent
          className="mt-0 min-h-0 flex-1 overflow-y-auto p-4"
          value="sql"
        >
          <ReportSqlContent active={tab === 'sql'} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

interface ReportEditorProps {
  report: IServiceReport | null;
}

export default function ReportEditor({
  report: initialReport,
}: ReportEditorProps) {
  const { organizationId, projectId } = useAppParams();
  const { reportId } = useParams({ strict: false });
  const router = useRouter();
  const savedReportSearch = useSearch({
    from: '/_app/$organizationId/$projectId/reports_/$reportId',
    shouldThrow: false,
  });
  const newReportSearch = useSearch({
    from: '/_app/$organizationId/$projectId/reports',
    shouldThrow: false,
  });
  const search = savedReportSearch ?? newReportSearch;
  const { isAboveLg } = useBreakpoint('lg');
  const dispatch = useDispatch();
  const report = useSelector((state) => state.report);
  const draftTokenRef = useRef<string | null>(search?.draft ?? null);
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const projectQuery = useQuery(
    trpc.project.getProjectWithClients.queryOptions(
      { projectId },
      {
        enabled: !!projectId,
        staleTime: 1000 * 60,
      }
    )
  );
  const dashboardQuery = useQuery(
    trpc.dashboard.byId.queryOptions(
      {
        id: search?.dashboardId ?? '',
        projectId,
      },
      {
        enabled: !!search?.dashboardId && !!projectId,
        staleTime: 1000 * 60,
      }
    )
  );

  const createReportFromName = useMutation(
    trpc.report.create.mutationOptions({
      onSuccess(res) {
        toast('Success', {
          description: 'Report created.',
        });
        queryClient.invalidateQueries(
          trpc.report.list.queryFilter({
            dashboardId: res.dashboardId,
            projectId: res.projectId,
          })
        );
        queryClient.invalidateQueries(trpc.dashboard.list.pathFilter());
        router
          .navigate({
            to: '/$organizationId/$projectId/reports/$reportId',
            params: {
              organizationId,
              projectId,
              reportId: res.id,
            },
            search: search?.dashboardId
              ? { dashboardId: search.dashboardId }
              : undefined,
          })
          .catch(handleError);
      },
      onError: handleError,
    })
  );

  const updateReportName = useMutation(
    trpc.report.update.mutationOptions({
      onSuccess(res) {
        if (search?.draft && reportId && organizationId && projectId) {
          clearReportDraft(search.draft);
          router
            .navigate({
              to: '/$organizationId/$projectId/reports/$reportId',
              params: {
                organizationId,
                projectId,
                reportId,
              },
              search: {
                ...(search ?? {}),
                draft: undefined,
              },
              replace: true,
            })
            .catch(handleError);
        }
        dispatch(resetDirty());
        toast('Success', {
          description: 'Report renamed.',
        });
        queryClient.invalidateQueries(
          trpc.report.list.queryFilter({
            dashboardId: res.dashboardId,
            projectId: res.projectId,
          })
        );
        queryClient.invalidateQueries(
          trpc.report.get.queryFilter({
            reportId,
          })
        );
      },
      onError: handleError,
    })
  );

  const handleReportNameSubmit = useCallback(
    (name: string) => {
      if (!(organizationId && projectId && report.ready)) {
        return;
      }

      if (!reportId) {
        if (!search?.dashboardId) {
          return;
        }

        createReportFromName.mutate({
          dashboardId: search.dashboardId,
          report: {
            ...report,
            name,
          },
        });
        return;
      }

      updateReportName.mutate({
        reportId,
        report: {
          ...report,
          name,
        },
      });
    },
    [
      createReportFromName,
      organizationId,
      projectId,
      report,
      report.ready,
      reportId,
      search?.dashboardId,
      updateReportName,
    ]
  );

  // Set report if reportId exists
  useEffect(() => {
    if (initialReport) {
      const draftToken = search?.draft;
      const draft =
        draftToken && initialReport.id ? loadReportDraft(draftToken) : null;

      if (draft && draft.reportId === initialReport.id) {
        dispatch(hydrateDraftReport(draft.report));
      } else {
        if (draftToken && organizationId && projectId) {
          clearReportDraft(draftToken);
          void router.navigate({
            to: '/$organizationId/$projectId/reports/$reportId',
            params: {
              organizationId,
              projectId,
              reportId: initialReport.id,
            },
            search: {
              ...(search ?? {}),
              draft: undefined,
            },
            replace: true,
          });
        }
        dispatch(setReport(initialReport));
      }
    } else {
      dispatch(ready());
    }

    return () => {
      dispatch(reset());
    };
  }, [dispatch, initialReport, organizationId, projectId, router]);

  useEffect(() => {
    draftTokenRef.current = search?.draft ?? null;
  }, [search?.draft]);

  useEffect(() => {
    if (
      !(reportId && organizationId && projectId && report.ready && report.dirty)
    ) {
      return;
    }

    let token = draftTokenRef.current;
    if (!token) {
      token = createReportDraftToken();
      draftTokenRef.current = token;

      void router.navigate({
        to: '/$organizationId/$projectId/reports/$reportId',
        params: {
          organizationId,
          projectId,
          reportId,
        },
        search: {
          ...(search ?? {}),
          draft: token,
        },
        replace: true,
      });
    }

    saveReportDraft(token, {
      reportId,
      report: {
        projectId: report.projectId,
        name: report.name,
        chartType: report.chartType,
        lineType: report.lineType,
        interval: report.interval,
        breakdowns: report.breakdowns,
        series: report.series,
        range: report.range,
        startDate: report.startDate,
        endDate: report.endDate,
        previous: report.previous,
        formula: report.formula,
        unit: report.unit,
        metric: report.metric,
        limit: report.limit,
        options: report.options,
        dateConfig: report.dateConfig,
      },
      updatedAt: new Date().toISOString(),
    });
  }, [
    organizationId,
    projectId,
    report,
    report.ready,
    report.dirty,
    reportId,
    router,
    search,
  ]);

  const breadcrumbItems: BreadcrumbItem[] = [
    {
      label: projectQuery.data?.name ?? projectId,
      to: '/$organizationId/$projectId/dashboards',
      params: {
        organizationId,
        projectId,
      },
    },
  ];

  if (search?.dashboardId && dashboardQuery.data) {
    breadcrumbItems.push({
      label: dashboardQuery.data.name,
      to: '/$organizationId/$projectId/dashboards/$dashboardId',
      params: {
        organizationId,
        projectId,
        dashboardId: search.dashboardId,
      },
    });
  }

  breadcrumbItems.push({
    label: report.name || 'New report',
  });

  return (
    <Sheet>
      <div>
        <div className="flex items-center justify-between gap-3 p-4">
          <div className="min-w-0 flex-1">
            <PageBreadcrumbs items={breadcrumbItems} />
            <div className="mt-2">
              <EditReportName onSubmit={handleReportNameSubmit} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ReportCacheBadge reportId={initialReport?.id} />
            {initialReport?.id && (
              <Button
                icon={ShareIcon}
                onClick={() =>
                  pushModal('ShareReportModal', { reportId: initialReport.id })
                }
                variant="outline"
              >
                Share
              </Button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 p-4 pt-0 md:grid-cols-6">
          {!isAboveLg && (
            <SheetTrigger asChild>
              <Button
                className="self-start"
                icon={GanttChartSquareIcon}
                variant="cta"
              >
                Pick events
              </Button>
            </SheetTrigger>
          )}
          <div
            className={
              isAboveLg
                ? 'col-span-5 grid grid-cols-2 gap-2 md:grid-cols-4'
                : 'col-span-4 grid grid-cols-2 gap-2 md:grid-cols-4'
            }
          >
            <ReportChartType
              className="min-w-0 flex-1"
              onChange={(type) => {
                dispatch(changeChartType(type));
              }}
              value={report.chartType}
            />
            <TimeWindowPicker
              className="min-w-0 flex-1"
              dateConfig={report.dateConfig}
              endDate={report.endDate}
              onChange={(value) => {
                dispatch(changeDateRanges(value));
              }}
              onDateConfigChange={(config) =>
                dispatch(changeDateConfig(config))
              }
              onEndDateChange={(date) => dispatch(changeEndDate(date))}
              onStartDateChange={(date) => dispatch(changeStartDate(date))}
              startDate={report.startDate}
              value={report.range}
            />
            <ReportInterval
              chartType={report.chartType}
              className="min-w-0 flex-1"
              dateConfig={report.dateConfig}
              endDate={report.endDate}
              interval={report.interval}
              onChange={(newInterval) => dispatch(changeInterval(newInterval))}
              range={report.range}
              startDate={report.startDate}
            />
            <ReportLineType className="min-w-0 flex-1" />
          </div>
          <div
            className={
              isAboveLg
                ? 'col-start-1 row-start-2 flex items-center justify-end gap-2 md:col-start-6 md:row-start-1'
                : 'col-start-2 row-start-1 flex items-center justify-end gap-2 md:col-start-6'
            }
          >
            <ReportSaveButton />
          </div>
        </div>
        <div className="flex flex-col gap-4 p-4 lg:flex-row" id="report-editor">
          <div className="min-w-0 flex-1">
            {report.ready && (
              <ReportChart
                isEditMode
                options={{
                  metricLayout:
                    report.chartType === 'metric' &&
                    report.breakdowns.length === 0
                      ? 'hero'
                      : 'compact',
                }}
                report={{ ...report, projectId }}
              />
            )}
          </div>
          {report.ready && <ReportInspector />}
        </div>
      </div>
      <SheetContent className="!max-w-lg" side="left">
        <ReportSidebar />
      </SheetContent>
    </Sheet>
  );
}
