import { Combobox } from '@/components/ui/combobox';
import { useDispatch, useSelector } from '@/redux';

import { ComboboxEvents } from '@/components/ui/combobox-events';
import { InputEnter } from '@/components/ui/input-enter';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAppParams } from '@/hooks/use-app-params';
import { useEventNames } from '@/hooks/use-event-names';
import { useMemo } from 'react';
import { useEventProperties } from '@/hooks/use-event-properties';
import {
  changeCriteria,
  changeFunnelBreakdownStep,
  changeFunnelGroup,
  changeFunnelProperty,
  changeFunnelWindow,
  changeFunnelWindowUnit,
  changePrevious,
  changeSankeyExclude,
  changeSankeyInclude,
  changeSankeyMode,
  changeSankeySteps,
  changeStacked,
  changeUnit,
} from '../reportSlice';

export function ReportSettings() {
  const chartType = useSelector((state) => state.report.chartType);
  const previous = useSelector((state) => state.report.previous);
  const unit = useSelector((state) => state.report.unit);
  const options = useSelector((state) => state.report.options);

  const retentionOptions = options?.type === 'retention' ? options : undefined;
  const criteria = retentionOptions?.criteria ?? 'on_or_after';

  const funnelOptions = options?.type === 'funnel' ? options : undefined;
  const funnelGroup = funnelOptions?.funnelGroup;
  const funnelWindow = funnelOptions?.funnelWindow;
  const funnelWindowUnit = funnelOptions?.funnelWindowUnit ?? 'hour';
  const breakdownStep = funnelOptions?.breakdownStep;
  const funnelProperty = funnelOptions?.funnelProperty;
  const seriesCount = useSelector((state) => state.report.series.length);

  const histogramOptions = options?.type === 'histogram' ? options : undefined;
  const stacked = histogramOptions?.stacked ?? false;

  const dispatch = useDispatch();
  const { projectId } = useAppParams();
  const eventNames = useEventNames({ projectId });
  // For funnel_metric, scope properties to the last funnel step event
  const series = useSelector((state) => state.report.series);
  const lastSeriesEvent = series.length > 0 ? series[series.length - 1] : null;
  const lastEventName = lastSeriesEvent && 'name' in lastSeriesEvent ? lastSeriesEvent.name : undefined;
  const lastCustomEventId = lastSeriesEvent && 'customEventId' in lastSeriesEvent ? lastSeriesEvent.customEventId : undefined;
  const hasLastStep = !!(lastEventName || lastCustomEventId);
  const eventProperties = useEventProperties(
    { projectId, event: lastEventName, customEventId: lastCustomEventId },
    { enabled: chartType === 'funnel_metric' && hasLastStep },
  );
  const propertyItems = useMemo(
    () =>
      eventProperties
        .filter((p) => p.startsWith('properties.'))
        .map((p) => ({ label: p.replace('properties.', ''), value: p })),
    [eventProperties],
  );

  const fields = useMemo(() => {
    const fields = [];

    if (chartType !== 'retention' && chartType !== 'sankey') {
      fields.push('previous');
    }

    if (chartType === 'retention') {
      fields.push('criteria');
      fields.push('unit');
    }

    if (chartType === 'funnel' || chartType === 'funnel_metric' || chartType === 'conversion') {
      fields.push('funnelGroup');
      fields.push('funnelWindow');
    }

    if (chartType === 'funnel' || chartType === 'funnel_metric') {
      fields.push('breakdownStep');
    }

    if (chartType === 'funnel_metric') {
      fields.push('funnelProperty');
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
  }, [chartType]);

  if (fields.length === 0) {
    return null;
  }

  return (
    <div>
      <h3 className="mb-2 font-medium">Settings</h3>
      <div className="col rounded-lg border bg-card p-4 gap-4">
        {fields.includes('previous') && (
          <Label className="flex items-center justify-between mb-0">
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
            <Label className="whitespace-nowrap font-medium mb-0">
              Criteria
            </Label>
            <Combobox
              align="end"
              placeholder="Select criteria"
              value={criteria}
              onChange={(val) => dispatch(changeCriteria(val))}
              items={[
                {
                  label: 'On or After',
                  value: 'on_or_after',
                },
                {
                  label: 'On',
                  value: 'on',
                },
              ]}
            />
          </div>
        )}
        {fields.includes('unit') && (
          <div className="flex items-center justify-between gap-4">
            <Label className="whitespace-nowrap font-medium mb-0">Unit</Label>
            <Combobox
              align="end"
              placeholder="Unit"
              value={unit || 'count'}
              onChange={(val) => {
                dispatch(changeUnit(val === 'count' ? undefined : val));
              }}
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
            />
          </div>
        )}
        {fields.includes('funnelGroup') && (
          <div className="flex items-center justify-between gap-4">
            <Label className="whitespace-nowrap font-medium mb-0">
              Funnel Group
            </Label>
            <Combobox
              align="end"
              placeholder="Default: Profile"
              value={funnelGroup || 'profile_id'}
              onChange={(val) => {
                dispatch(
                  changeFunnelGroup(val === 'profile_id' ? undefined : val),
                );
              }}
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
            />
          </div>
        )}
        {fields.includes('funnelWindow') && (
          <div className="flex items-center justify-between gap-4">
            <Label className="whitespace-nowrap font-medium mb-0">
              Funnel Window
            </Label>
            <div className="flex items-center gap-2">
              <InputEnter
                type="number"
                className="w-20"
                value={funnelWindow ? String(funnelWindow) : ''}
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
                onChangeValue={(value) => {
                  const parsed = Number.parseFloat(value);
                  if (Number.isNaN(parsed)) {
                    dispatch(changeFunnelWindow(undefined));
                  } else {
                    dispatch(changeFunnelWindow(parsed));
                  }
                }}
              />
              <Combobox
                align="end"
                placeholder="hours"
                value={funnelWindowUnit}
                onChange={(val) => {
                  dispatch(
                    changeFunnelWindowUnit(
                      val === 'hour' ? undefined : val,
                    ),
                  );
                }}
                items={[
                  { label: 'seconds', value: 'second' },
                  { label: 'minutes', value: 'minute' },
                  { label: 'hours', value: 'hour' },
                  { label: 'days', value: 'day' },
                  { label: 'weeks', value: 'week' },
                  { label: 'months', value: 'month' },
                ]}
              />
            </div>
          </div>
        )}
        {fields.includes('breakdownStep') && (
          <div className="flex items-center justify-between gap-4">
            <Label className="whitespace-nowrap font-medium mb-0">
              Breakdown Step
            </Label>
            <Combobox
              align="end"
              placeholder="All steps"
              value={
                breakdownStep !== undefined ? String(breakdownStep) : 'all'
              }
              onChange={(val) => {
                dispatch(
                  changeFunnelBreakdownStep(
                    val === 'all' ? undefined : Number(val),
                  ),
                );
              }}
              items={[
                { label: 'All steps', value: 'all' },
                ...Array.from({ length: seriesCount }, (_, i) => ({
                  label: `Step ${i + 1}`,
                  value: String(i),
                })),
              ]}
            />
          </div>
        )}
        {fields.includes('funnelProperty') && (
          <div className="flex items-center justify-between gap-4">
            <Label className="whitespace-nowrap font-medium mb-0">
              Sum Property
            </Label>
            <Combobox
              align="end"
              searchable
              placeholder="Select property"
              value={funnelProperty || ''}
              onChange={(val) => {
                dispatch(changeFunnelProperty(val || undefined));
              }}
              items={propertyItems}
            />
          </div>
        )}
        {fields.includes('sankeyMode') && options?.type === 'sankey' && (
          <div className="flex items-center justify-between gap-4">
            <Label className="whitespace-nowrap font-medium mb-0">Mode</Label>
            <Combobox
              align="end"
              placeholder="Select mode"
              value={options?.mode || 'after'}
              onChange={(val) => {
                dispatch(
                  changeSankeyMode(val as 'between' | 'after' | 'before'),
                );
              }}
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
            />
          </div>
        )}
        {fields.includes('sankeySteps') && options?.type === 'sankey' && (
          <div className="flex items-center justify-between gap-4">
            <Label className="whitespace-nowrap font-medium mb-0">Steps</Label>
            <InputEnter
              type="number"
              value={options?.steps ? String(options.steps) : '5'}
              placeholder="Default: 5"
              onChangeValue={(value) => {
                const parsed = Number.parseInt(value, 10);
                if (Number.isNaN(parsed) || parsed < 2 || parsed > 10) {
                  dispatch(changeSankeySteps(5));
                } else {
                  dispatch(changeSankeySteps(parsed));
                }
              }}
            />
          </div>
        )}
        {fields.includes('sankeyExclude') && options?.type === 'sankey' && (
          <div className="flex flex-col">
            <Label className="whitespace-nowrap font-medium">
              Exclude Events
            </Label>
            <ComboboxEvents
              multiple
              searchable
              value={options?.exclude || []}
              onChange={(value) => {
                dispatch(changeSankeyExclude(value));
              }}
              items={eventNames.filter((item) => item.name !== '*')}
              placeholder="Select events to exclude"
            />
          </div>
        )}
        {fields.includes('sankeyInclude') && options?.type === 'sankey' && (
          <div className="flex flex-col">
            <Label className="whitespace-nowrap font-medium">
              Include events
            </Label>
            <ComboboxEvents
              multiple
              searchable
              value={options?.include || []}
              onChange={(value) => {
                dispatch(
                  changeSankeyInclude(value.length > 0 ? value : undefined),
                );
              }}
              items={eventNames.filter((item) => item.name !== '*')}
              placeholder="Leave empty to include all"
            />
          </div>
        )}
        {fields.includes('stacked') && (
          <Label className="flex items-center justify-between mb-0">
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
