import { useMemo } from 'react';
import { extractRetentionSelection } from '@openpanel/db';
import {
  changeCriteria,
  changeFunnelBreakdownStep,
  changeFunnelGroup,
  changeFunnelMeasure,
  changeFunnelProperty,
  changeFunnelWindow,
  changeFunnelWindowUnit,
  changePrevious,
  changeRetentionBreakdownSort,
  changeRetentionMetric,
  changeRetentionProperty,
  changeRetentionPropertyAverageDenominatorStep,
  changeRetentionTopN,
  changeRetentionUnit,
  changeSankeyExclude,
  changeSankeyInclude,
  changeSankeyMode,
  changeSankeySteps,
  changeStacked,
  changeUnit,
} from '../reportSlice';
import { Combobox } from '@/components/ui/combobox';
import { ComboboxEvents } from '@/components/ui/combobox-events';
import { InputEnter } from '@/components/ui/input-enter';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAppParams } from '@/hooks/use-app-params';
import { useEventNames } from '@/hooks/use-event-names';
import { useEventProperties } from '@/hooks/use-event-properties';
import { useDispatch, useSelector } from '@/redux';

export function ReportSettings() {
  const chartType = useSelector((state) => state.report.chartType);
  const previous = useSelector((state) => state.report.previous);
  const unit = useSelector((state) => state.report.unit);
  const options = useSelector((state) => state.report.options);

  const retentionOptions = options?.type === 'retention' ? options : undefined;
  const criteria = retentionOptions?.criteria ?? 'on_or_after';
  const retentionMetric =
    retentionOptions?.metric ??
    (unit === '%' ? 'retention_rate' : 'unique_users');
  const retentionProperty = retentionOptions?.property;
  const retentionUnit = retentionOptions?.retentionUnit ?? 'day';
  const retentionPropertyAverageDenominatorStep =
    retentionOptions?.propertyAverageDenominatorStep ?? 0;
  const retentionTopN = retentionOptions?.topN ?? 20;
  const retentionBreakdownSort =
    retentionOptions?.breakdownSort ?? 'profile_count_desc';
  const breakdownCount = useSelector((state) => state.report.breakdowns.length);

  const funnelOptions = options?.type === 'funnel' ? options : undefined;
  const funnelGroup = funnelOptions?.funnelGroup;
  const funnelWindow = funnelOptions?.funnelWindow;
  const funnelWindowUnit = funnelOptions?.funnelWindowUnit ?? 'hour';
  const breakdownStep = funnelOptions?.breakdownStep;
  const funnelProperty = funnelOptions?.funnelProperty;
  const funnelMeasure = funnelOptions?.funnelMeasure ?? 'conversion_rate';
  const seriesCount = useSelector((state) => state.report.series.length);

  const histogramOptions = options?.type === 'histogram' ? options : undefined;
  const stacked = histogramOptions?.stacked ?? false;

  const dispatch = useDispatch();
  const { projectId } = useAppParams();
  const eventNames = useEventNames({ projectId });
  // For funnel property measures, scope properties to the last funnel step event
  const series = useSelector((state) => state.report.series);
  const propertySourceEvent =
    chartType === 'retention'
      ? series[1]
      : series.length > 0
        ? series[series.length - 1]
        : null;
  const propertySourceEventName =
    propertySourceEvent && 'name' in propertySourceEvent
      ? chartType === 'retention'
        ? String(
            // By predicate: filters[0] is not necessarily the event selector.
            extractRetentionSelection(propertySourceEvent as any).names[0] ??
              propertySourceEvent.name
          )
        : propertySourceEvent.name
      : undefined;
  const propertySourceCustomEventId =
    propertySourceEvent && 'customEventId' in propertySourceEvent
      ? propertySourceEvent.customEventId
      : undefined;
  const hasPropertySource = !!(
    propertySourceEventName || propertySourceCustomEventId
  );
  const eventProperties = useEventProperties(
    {
      projectId,
      event: propertySourceEventName,
      customEventId: propertySourceCustomEventId,
    },
    {
      enabled:
        (chartType === 'funnel' ||
          chartType === 'funnel_metric' ||
          chartType === 'retention') &&
        hasPropertySource,
    }
  );
  const propertyItems = useMemo(
    () =>
      eventProperties
        .filter((p) => p.startsWith('properties.'))
        .map((p) => ({ label: p.replace('properties.', ''), value: p })),
    [eventProperties]
  );

  const fields = useMemo(() => {
    const fields = [];

    if (chartType !== 'retention' && chartType !== 'sankey') {
      fields.push('previous');
    }

    if (chartType === 'retention') {
      fields.push('criteria');
      fields.push('retentionUnit');
      fields.push('retentionMetric');
      fields.push('retentionProperty');
      fields.push('retentionPropertyAverageDenominatorStep');
      fields.push('unit');
      if (breakdownCount > 0) {
        fields.push('retentionBreakdownSort');
        fields.push('retentionTopN');
      }
    }

    if (
      chartType === 'funnel' ||
      chartType === 'funnel_metric' ||
      chartType === 'conversion'
    ) {
      fields.push('funnelGroup');
      fields.push('funnelWindow');
    }

    if (chartType === 'funnel') {
      fields.push('funnelMeasure');
    }

    if (
      chartType === 'funnel_metric' ||
      (chartType === 'funnel' &&
        (funnelMeasure === 'property_sum' ||
          funnelMeasure === 'property_average'))
    ) {
      fields.push('funnelProperty');
    }

    if (chartType === 'funnel' || chartType === 'funnel_metric') {
      fields.push('breakdownStep');
    }

    if (chartType === 'sankey') {
      fields.push('sankeyMode');
      fields.push('sankeySteps');
      fields.push('sankeyExclude');
      fields.push('sankeyInclude');
    }

    if (chartType === 'histogram') {
      fields.push('stacked');
    }

    return fields;
  }, [breakdownCount, chartType, funnelMeasure]);

  if (fields.length === 0) {
    return null;
  }

  return (
    <div>
      <h3 className="mb-2 font-medium">Settings</h3>
      <div className="col gap-4 rounded-lg border bg-card p-4">
        {fields.includes('previous') && (
          <Label className="mb-0 flex items-center justify-between">
            <span className="whitespace-nowrap">
              Compare to previous period
            </span>
            <Switch
              checked={previous}
              onCheckedChange={(val) => dispatch(changePrevious(!!val))}
            />
          </Label>
        )}
        {fields.includes('criteria') && (
          <div className="flex items-center justify-between gap-4">
            <Label className="mb-0 whitespace-nowrap font-medium">
              Criteria
            </Label>
            <Combobox
              align="end"
              items={[
                {
                  label: 'On or After',
                  value: 'on_or_after',
                },
                {
                  label: 'On',
                  value: 'on',
                },
                {
                  label: 'On or Before',
                  value: 'on_or_before',
                },
              ]}
              onChange={(val) => dispatch(changeCriteria(val))}
              placeholder="Select criteria"
              value={criteria}
            />
          </div>
        )}
        {fields.includes('retentionUnit') && (
          <div className="flex items-center justify-between gap-4">
            <Label className="mb-0 whitespace-nowrap font-medium">
              Conversion Window
            </Label>
            <Combobox
              align="end"
              items={[
                { label: 'Each Day', value: 'day' },
                { label: 'Each Week', value: 'week' },
                { label: 'Each Month', value: 'month' },
              ]}
              onChange={(val) =>
                dispatch(
                  changeRetentionUnit(
                    val === 'week' || val === 'month' ? val : undefined
                  )
                )
              }
              placeholder="Each Day"
              value={retentionUnit}
            />
          </div>
        )}
        {fields.includes('retentionMetric') && (
          <div className="flex items-center justify-between gap-4">
            <Label className="mb-0 whitespace-nowrap font-medium">
              Measure
            </Label>
            <Combobox
              align="end"
              items={[
                { label: 'Retention Rate', value: 'retention_rate' },
                { label: 'Unique Users', value: 'unique_users' },
                { label: 'Property Sum', value: 'property_sum' },
                { label: 'Property Average', value: 'property_average' },
              ]}
              onChange={(val) => {
                const metric = val as
                  | 'retention_rate'
                  | 'unique_users'
                  | 'property_sum'
                  | 'property_average';
                dispatch(changeRetentionMetric(metric));
                if (metric === 'retention_rate') {
                  dispatch(changeUnit('%'));
                } else if (metric === 'unique_users') {
                  dispatch(changeUnit(undefined));
                }
              }}
              placeholder="Measure"
              value={retentionMetric}
            />
          </div>
        )}
        {fields.includes('retentionProperty') &&
          (retentionMetric === 'property_sum' ||
            retentionMetric === 'property_average') && (
            <div className="flex items-center justify-between gap-4">
              <Label className="mb-0 whitespace-nowrap font-medium">
                {retentionMetric === 'property_sum'
                  ? 'Sum Property'
                  : 'Average Property'}
              </Label>
              <Combobox
                align="end"
                items={propertyItems}
                onChange={(val) => {
                  dispatch(changeRetentionProperty(val || undefined));
                }}
                placeholder="Select property"
                searchable
                value={retentionProperty || ''}
              />
            </div>
          )}
        {fields.includes('retentionPropertyAverageDenominatorStep') &&
          retentionMetric === 'property_average' && (
            <div className="flex items-center justify-between gap-4">
              <Label className="mb-0 whitespace-nowrap font-medium">
                Denominator Step
              </Label>
              <Combobox
                align="end"
                items={Array.from(
                  { length: Math.max(2, seriesCount) },
                  (_, i) => ({
                    label: `Step ${i + 1}`,
                    value: String(i),
                  })
                )}
                onChange={(val) => {
                  const step = Number(val);
                  dispatch(
                    changeRetentionPropertyAverageDenominatorStep(
                      Number.isNaN(step) || step <= 0 ? undefined : step
                    )
                  );
                }}
                placeholder="Step 1"
                value={String(retentionPropertyAverageDenominatorStep)}
              />
            </div>
          )}
        {fields.includes('unit') && retentionMetric === 'unique_users' && (
          <div className="flex items-center justify-between gap-4">
            <Label className="mb-0 whitespace-nowrap font-medium">Unit</Label>
            <Combobox
              align="end"
              items={[
                {
                  label: 'Count',
                  value: 'count',
                },
                {
                  label: '%',
                  value: '%',
                },
              ]}
              onChange={(val) => {
                dispatch(changeUnit(val === 'count' ? undefined : val));
              }}
              placeholder="Unit"
              value={unit || 'count'}
            />
          </div>
        )}
        {fields.includes('retentionBreakdownSort') && (
          <div className="flex items-center justify-between gap-4">
            <Label className="mb-0 whitespace-nowrap font-medium">
              Sort by Profiles
            </Label>
            <Combobox
              align="end"
              items={[
                { label: 'High to Low', value: 'profile_count_desc' },
                { label: 'Low to High', value: 'profile_count_asc' },
              ]}
              onChange={(val) =>
                dispatch(
                  changeRetentionBreakdownSort(
                    val === 'profile_count_asc'
                      ? 'profile_count_asc'
                      : undefined
                  )
                )
              }
              placeholder="High to Low"
              value={retentionBreakdownSort}
            />
          </div>
        )}
        {fields.includes('retentionTopN') && (
          <div className="flex items-center justify-between gap-4">
            <Label className="mb-0 whitespace-nowrap font-medium">
              Show Top
            </Label>
            <Combobox
              align="end"
              items={[1, 3, 5, 10, 20].map((value) => ({
                label: `Top ${value}`,
                value: String(value),
              }))}
              onChange={(val) => dispatch(changeRetentionTopN(Number(val)))}
              placeholder="Top 20"
              value={String(retentionTopN)}
            />
          </div>
        )}
        {fields.includes('funnelGroup') && (
          <div className="flex items-center justify-between gap-4">
            <Label className="mb-0 whitespace-nowrap font-medium">
              Funnel Group
            </Label>
            <Combobox
              align="end"
              items={[
                {
                  label: 'Session',
                  value: 'session_id',
                },
                {
                  label: 'Profile',
                  value: 'profile_id',
                },
              ]}
              onChange={(val) => {
                dispatch(
                  changeFunnelGroup(val === 'profile_id' ? undefined : val)
                );
              }}
              placeholder="Default: Profile"
              value={funnelGroup || 'profile_id'}
            />
          </div>
        )}
        {fields.includes('funnelWindow') && (
          <div className="flex items-center justify-between gap-4">
            <Label className="mb-0 whitespace-nowrap font-medium">
              Funnel Window
            </Label>
            <div className="flex items-center gap-2">
              <InputEnter
                className="w-20"
                onChangeValue={(value) => {
                  const parsed = Number.parseFloat(value);
                  if (Number.isNaN(parsed)) {
                    dispatch(changeFunnelWindow(undefined));
                  } else {
                    dispatch(changeFunnelWindow(parsed));
                  }
                }}
                placeholder={
                  {
                    second: '86400',
                    minute: '1440',
                    hour: '24',
                    day: '1',
                    week: '1',
                    month: '1',
                  }[funnelWindowUnit] ?? '24'
                }
                type="number"
                value={funnelWindow ? String(funnelWindow) : ''}
              />
              <Combobox
                align="end"
                items={[
                  { label: 'seconds', value: 'second' },
                  { label: 'minutes', value: 'minute' },
                  { label: 'hours', value: 'hour' },
                  { label: 'days', value: 'day' },
                  { label: 'weeks', value: 'week' },
                  { label: 'months', value: 'month' },
                ]}
                onChange={(val) => {
                  dispatch(
                    changeFunnelWindowUnit(val === 'hour' ? undefined : val)
                  );
                }}
                placeholder="hours"
                value={funnelWindowUnit}
              />
            </div>
          </div>
        )}
        {fields.includes('funnelMeasure') && (
          <div className="flex items-center justify-between gap-4">
            <Label className="mb-0 whitespace-nowrap font-medium">
              Measure
            </Label>
            <Combobox
              align="end"
              items={[
                { label: 'Conversion Rate', value: 'conversion_rate' },
                { label: 'Unique Users', value: 'unique_users' },
                { label: 'Property Sum', value: 'property_sum' },
                { label: 'Property Average', value: 'property_average' },
              ]}
              onChange={(val) => {
                dispatch(
                  changeFunnelMeasure(
                    val === 'conversion_rate'
                      ? undefined
                      : (val as
                          | 'unique_users'
                          | 'property_sum'
                          | 'property_average')
                  )
                );
              }}
              placeholder="Measure"
              value={funnelMeasure}
            />
          </div>
        )}
        {fields.includes('funnelProperty') && (
          <div className="flex items-center justify-between gap-4">
            <Label className="mb-0 whitespace-nowrap font-medium">
              {funnelMeasure === 'property_average'
                ? 'Average Property'
                : 'Sum Property'}
            </Label>
            <Combobox
              align="end"
              items={propertyItems}
              onChange={(val) => {
                dispatch(changeFunnelProperty(val || undefined));
              }}
              placeholder="Select property"
              searchable
              value={funnelProperty || ''}
            />
          </div>
        )}
        {fields.includes('breakdownStep') && (
          <div className="flex items-center justify-between gap-4">
            <Label className="mb-0 whitespace-nowrap font-medium">
              Breakdown Step
            </Label>
            <Combobox
              align="end"
              items={[
                { label: 'All steps', value: 'all' },
                ...Array.from({ length: seriesCount }, (_, i) => ({
                  label: `Step ${i + 1}`,
                  value: String(i),
                })),
              ]}
              onChange={(val) => {
                dispatch(
                  changeFunnelBreakdownStep(
                    val === 'all' ? undefined : Number(val)
                  )
                );
              }}
              placeholder="All steps"
              value={
                breakdownStep !== undefined ? String(breakdownStep) : 'all'
              }
            />
          </div>
        )}
        {fields.includes('sankeyMode') && options?.type === 'sankey' && (
          <div className="flex items-center justify-between gap-4">
            <Label className="mb-0 whitespace-nowrap font-medium">Mode</Label>
            <Combobox
              align="end"
              items={[
                {
                  label: 'After',
                  value: 'after',
                },
                {
                  label: 'Before',
                  value: 'before',
                },
                {
                  label: 'Between',
                  value: 'between',
                },
              ]}
              onChange={(val) => {
                dispatch(
                  changeSankeyMode(val as 'between' | 'after' | 'before')
                );
              }}
              placeholder="Select mode"
              value={options?.mode || 'after'}
            />
          </div>
        )}
        {fields.includes('sankeySteps') && options?.type === 'sankey' && (
          <div className="flex items-center justify-between gap-4">
            <Label className="mb-0 whitespace-nowrap font-medium">Steps</Label>
            <InputEnter
              onChangeValue={(value) => {
                const parsed = Number.parseInt(value, 10);
                if (Number.isNaN(parsed) || parsed < 2 || parsed > 10) {
                  dispatch(changeSankeySteps(5));
                } else {
                  dispatch(changeSankeySteps(parsed));
                }
              }}
              placeholder="Default: 5"
              type="number"
              value={options?.steps ? String(options.steps) : '5'}
            />
          </div>
        )}
        {fields.includes('sankeyExclude') && options?.type === 'sankey' && (
          <div className="flex flex-col">
            <Label className="whitespace-nowrap font-medium">
              Exclude Events
            </Label>
            <ComboboxEvents
              items={eventNames.filter((item) => item.name !== '*')}
              multiple
              onChange={(value) => {
                dispatch(changeSankeyExclude(value));
              }}
              placeholder="Select events to exclude"
              searchable
              value={options?.exclude || []}
            />
          </div>
        )}
        {fields.includes('sankeyInclude') && options?.type === 'sankey' && (
          <div className="flex flex-col">
            <Label className="whitespace-nowrap font-medium">
              Include events
            </Label>
            <ComboboxEvents
              items={eventNames.filter((item) => item.name !== '*')}
              multiple
              onChange={(value) => {
                dispatch(
                  changeSankeyInclude(value.length > 0 ? value : undefined)
                );
              }}
              placeholder="Leave empty to include all"
              searchable
              value={options?.include || []}
            />
          </div>
        )}
        {fields.includes('stacked') && (
          <Label className="mb-0 flex items-center justify-between">
            <span className="whitespace-nowrap">Stack series</span>
            <Switch
              checked={stacked}
              onCheckedChange={(val) => dispatch(changeStacked(!!val))}
            />
          </Label>
        )}
      </div>
    </div>
  );
}
