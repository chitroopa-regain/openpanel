import { CohortPickerDialog } from '@/components/custom-cohorts/cohort-picker-dialog';
import { ColorSquare } from '@/components/color-square';
import { useTRPC } from '@/integrations/trpc/react';
import { useAppParams } from '@/hooks/use-app-params';
import { useQuery } from '@tanstack/react-query';
import { useDispatch, useSelector } from '@/redux';
import { ChevronsUpDownIcon, SplitIcon, TargetIcon, XIcon } from 'lucide-react';
import { useState } from 'react';

import type {
  IChartBreakdown,
  IChartCustomEvent,
  IChartEvent,
  IChartEventItem,
} from '@openpanel/validation';

import { Button } from '@/components/ui/button';
import { Tooltiper } from '@/components/ui/tooltip';
import {
  COHORT_BREAKDOWN_UNSUPPORTED_CHART_TYPES,
  addBreakdown,
  changeBreakdown,
  changeCohortBreakdown,
  removeBreakdown,
} from '../reportSlice';
import { PropertiesCombobox } from './PropertiesCombobox';
import { ReportBreakdownMore } from './ReportBreakdownMore';
import type { ReportEventMoreProps } from './ReportEventMore';

export function ReportBreakdowns() {
  const selectedBreakdowns = useSelector((state) => state.report.breakdowns);
  const chartType = useSelector((state) => state.report.chartType);
  const options = useSelector((state) => state.report.options);
  const series = useSelector((state) => state.report.series);
  const cohortBreakdown = useSelector((state) => state.report.cohortBreakdown);
  const dispatch = useDispatch();
  const [cohortPickerOpen, setCohortPickerOpen] = useState(false);
  const { projectId } = useAppParams();
  const trpc = useTRPC();
  const cohortsQuery = useQuery(
    trpc.customCohort.list.queryOptions({ projectId })
  );
  const selectedCohortIds = cohortBreakdown?.cohortIds ?? [];
  const cohortName = (id: string) =>
    (cohortsQuery.data ?? []).find((c) => c.id === id)?.name ?? id;

  // Cohort breakdown is only applied on the chart/aggregate query paths.
  // Offering it elsewhere would accept a selection that silently does nothing.
  const cohortDisabledReason = COHORT_BREAKDOWN_UNSUPPORTED_CHART_TYPES.has(
    chartType,
  )
    ? `Not available on ${chartType.replace('_', ' ')} charts`
    : undefined;

  const cohortBreakdownSupported =
    chartType !== 'funnel' &&
    chartType !== 'funnel_metric' &&
    chartType !== 'retention' &&
    chartType !== 'sankey' &&
    chartType !== 'conversion';

  let scopedBreakdownSource: IChartEventItem | undefined;
  if (chartType === 'retention') {
    scopedBreakdownSource = series[0];
  } else if (
    (chartType === 'funnel' || chartType === 'funnel_metric') &&
    options?.type === 'funnel' &&
    options.breakdownStep !== undefined &&
    options.breakdownStep >= 0 &&
    options.breakdownStep < series.length
  ) {
    scopedBreakdownSource = series[options.breakdownStep];
  }

  const scopedBreakdownProps = getScopedBreakdownProps(scopedBreakdownSource);

  const handleMore = (breakdown: IChartBreakdown) => {
    const callback: ReportEventMoreProps['onClick'] = (action) => {
      switch (action) {
        case 'remove': {
          return dispatch(removeBreakdown(breakdown));
        }
      }
    };

    return callback;
  };

  return (
    <div>
      <h3 className="mb-2 font-medium">Breakdown</h3>
      <div className="flex flex-col gap-4">
        {selectedCohortIds.length > 0 && (
          <div className="flex flex-col gap-1" data-testid="cohort-breakdown-chips">
            {selectedCohortIds.map((id, index) => (
              <div
                className="flex items-center gap-2 rounded-lg border bg-def-100 p-2 px-3"
                key={id}
              >
                <ColorSquare className="shrink-0">{index}</ColorSquare>
                <TargetIcon className="size-4 shrink-0 text-violet-500" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {cohortName(id)}
                </span>
                <Button
                  onClick={() =>
                    dispatch(
                      changeCohortBreakdown(
                        selectedCohortIds.filter((x) => x !== id)
                      )
                    )
                  }
                  size="icon"
                  variant="ghost"
                >
                  <XIcon className="size-3" />
                </Button>
              </div>
            ))}
            <Button
              className="self-start"
              onClick={() => setCohortPickerOpen(true)}
              size="sm"
              variant="ghost"
            >
              Edit cohorts
            </Button>
          </div>
        )}
        {selectedBreakdowns.map((item, index) => {
          return (
            <div key={item.name} className="rounded-lg border bg-def-100">
              <div className="flex min-w-0 items-center gap-2 p-2 px-4">
                <ColorSquare className="shrink-0">{index}</ColorSquare>
                <PropertiesCombobox
                  {...scopedBreakdownProps}
                  onSelect={(action) => {
                    dispatch(
                      changeBreakdown({
                        ...item,
                        name: action.value,
                      })
                    );
                  }}
                  onSelectCohort={() => setCohortPickerOpen(true)}
                  cohortDisabledReason={cohortDisabledReason}
                >
                  {(setOpen) => (
                    <Button
                      aria-label={item.name}
                      variant={'outline'}
                      onClick={() => setOpen((prev) => !prev)}
                      size={'sm'}
                      autoHeight
                      className="min-w-0 flex-1"
                    >
                      <div className="row min-w-0 flex-1 gap-2 items-center">
                        <SplitIcon className="size-4 shrink-0" />
                        <Tooltiper
                          asChild
                          content={item.name}
                          side="top"
                          sideOffset={6}
                          tooltipClassName="max-w-sm break-all"
                        >
                          <span className="min-w-0 truncate">{item.name}</span>
                        </Tooltiper>
                      </div>
                      <ChevronsUpDownIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  )}
                </PropertiesCombobox>
                <div className="shrink-0">
                  <ReportBreakdownMore onClick={handleMore(item)} />
                </div>
              </div>
            </div>
          );
        })}

        <PropertiesCombobox
          {...scopedBreakdownProps}
          onSelect={(action) => {
            dispatch(
              addBreakdown({
                name: action.value,
              })
            );
          }}
          onSelectCohort={() => setCohortPickerOpen(true)}
          cohortDisabledReason={cohortDisabledReason}
        >
          {(setOpen) => (
            <Button
              variant={'outline'}
              onClick={() => setOpen((prev) => !prev)}
              size={'sm'}
              autoHeight
              className="min-w-0 flex-1"
            >
              <div className="row min-w-0 flex-1 gap-2 items-center">
                <SplitIcon className="size-4 shrink-0" />
                <span className="min-w-0 truncate">Select breakdown</span>
              </div>
              <ChevronsUpDownIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          )}
        </PropertiesCombobox>

        <CohortPickerDialog
          onConfirm={(ids) => dispatch(changeCohortBreakdown(ids))}
          onOpenChange={setCohortPickerOpen}
          open={cohortPickerOpen}
          value={selectedCohortIds}
        />
      </div>
    </div>
  );
}

function getScopedBreakdownProps(source?: IChartEventItem): {
  event?: IChartEvent;
  customEventId?: string;
} {
  if (!source || source.type === 'formula') {
    return {};
  }

  if (source.type === 'custom_event') {
    return {
      customEventId: (source as IChartCustomEvent).customEventId,
    };
  }

  return {
    event: source as IChartEvent,
  };
}
