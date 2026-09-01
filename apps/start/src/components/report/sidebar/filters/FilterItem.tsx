import { ColorSquare } from '@/components/color-square';
import { FilterOperatorSelect } from '@/components/report/sidebar/filters/FilterOperatorSelect';
import { RenderDots } from '@/components/ui/RenderDots';
import { Button } from '@/components/ui/button';
import { ComboboxAdvanced } from '@/components/ui/combobox-advanced';
import { InputEnter } from '@/components/ui/input-enter';
import { useAppParams } from '@/hooks/use-app-params';
import { usePropertyValues } from '@/hooks/use-property-values';
import { useDispatch } from '@/redux';
import type {
  IChartCustomEvent,
  IChartEvent,
  IChartEventFilter,
  IChartEventFilterOperator,
  IChartEventFilterValue,
} from '@openpanel/validation';
import { SlidersHorizontal, Trash } from 'lucide-react';
import { useEffect } from 'react';
import { changeEvent } from '../../reportSlice';
import {
  defaultEpochDateOperator,
  inferEpochUnit,
  isEpochDateComparisonOperator,
} from './epoch-date-filter.utils';
import { EpochDateFilterValue } from './epoch-date-filter-value';

const DATE_OPERATOR_ITEMS: Array<{
  value: IChartEventFilterOperator;
  label: string;
}> = [
  { value: 'gte', label: 'On or after' },
  { value: 'gt', label: 'After' },
  { value: 'lte', label: 'On or before' },
  { value: 'lt', label: 'Before' },
  { value: 'isNotNull', label: 'Is set' },
  { value: 'isNull', label: 'Is not set' },
];

interface FilterProps {
  event: IChartEvent | IChartCustomEvent;
  filter: IChartEventFilter;
}

interface PureFilterProps {
  eventName: string;
  customEventId?: string;
  filter: IChartEventFilter;
  onRemove: (filter: IChartEventFilter) => void;
  onChangeValue: (
    value: IChartEventFilterValue[],
    filter: IChartEventFilter,
  ) => void;
  onChangeOperator: (
    operator: IChartEventFilterOperator,
    filter: IChartEventFilter,
  ) => void;
  className?: string;
  immediateInput?: boolean;
}

export function FilterItem({ filter, event }: FilterProps) {
  const onRemove = ({ id }: IChartEventFilter) => {
    dispatch(
      changeEvent({
        ...event,
        filters: event.filters.filter((item) => item.id !== id),
      } as any),
    );
  };

  const onChangeValue = (
    value: IChartEventFilterValue[],
    { id }: IChartEventFilter,
  ) => {
    dispatch(
      changeEvent({
        ...event,
        filters: event.filters.map((item) => {
          if (item.id === id) {
            return {
              ...item,
              value,
            };
          }

          return item;
        }),
      } as any),
    );
  };

  const onChangeOperator = (
    operator: IChartEventFilterOperator,
    { id }: IChartEventFilter,
  ) => {
    dispatch(
      changeEvent({
        ...event,
        filters: event.filters.map((item) => {
          if (item.id === id) {
            return {
              ...item,
              value: item.value ? item.value.filter(Boolean).slice(0, 1) : [],
              operator,
            };
          }

          return item;
        }),
      } as any),
    );
  };

  const dispatch = useDispatch();
  const rawEventName =
    'name' in event ? event.name : (event.displayName ?? '*');
  const nameFilter = event.filters?.find(
    (item) =>
      item.name === 'name' &&
      item.operator === 'is' &&
      item.value.length === 1 &&
      typeof item.value[0] === 'string',
  );
  // Retention represents its selected event as `name = <event>` on a wildcard
  // series. Use that concrete name for property-value lookups so ClickHouse can
  // prune by the events table's `(project_id, date, name, ...)` sorting key.
  const eventName =
    rawEventName === '*' && nameFilter
      ? String(nameFilter.value[0])
      : rawEventName;
  const customEventId =
    'customEventId' in event ? event.customEventId : undefined;

  return (
    <PureFilterItem
      filter={filter}
      eventName={eventName}
      customEventId={customEventId}
      onRemove={onRemove}
      onChangeValue={onChangeValue}
      onChangeOperator={onChangeOperator}
      className="px-4 py-2 shadow-[inset_6px_0_0] shadow-def-300 first:border-t"
    />
  );
}

export function PureFilterItem({
  filter,
  eventName,
  customEventId,
  onRemove,
  onChangeValue,
  onChangeOperator,
  className,
  immediateInput,
}: PureFilterProps) {
  const { projectId } = useAppParams();

  const potentialValues = usePropertyValues({
    event: eventName,
    property: filter.name,
    projectId,
    customEventId,
  });

  const valuesCombobox =
    potentialValues.map((item) => ({
      value: item,
      label: item,
    })) ?? [];
  const epochUnit = inferEpochUnit(filter.name, [
    ...potentialValues,
    ...filter.value,
  ]);
  const operatorNeedsNoValue =
    filter.operator === 'isNull' || filter.operator === 'isNotNull';

  const removeFilter = () => {
    onRemove(filter);
  };

  const changeFilterValue = (value: IChartEventFilterValue[]) => {
    onChangeValue(value, filter);
  };

  const changeFilterOperator = (operator: IChartEventFilterOperator) => {
    onChangeOperator(operator, filter);
  };

  useEffect(() => {
    // A newly-added property filter starts as `is` with no value. Once its
    // sampled values prove that it is an epoch timestamp, move it to a useful
    // date comparison instead of offering exact millisecond equality.
    const nextOperator = defaultEpochDateOperator(
      epochUnit,
      filter.operator,
      filter.value.length,
    );
    if (nextOperator) {
      changeFilterOperator(nextOperator);
    }
  }, [epochUnit, filter.operator, filter.value.length]);

  let filterValueControl: React.ReactNode = null;
  if (!operatorNeedsNoValue) {
    if (epochUnit && isEpochDateComparisonOperator(filter.operator)) {
      filterValueControl = (
        <EpochDateFilterValue
          value={filter.value[0]}
          unit={epochUnit}
          onChange={(value) => changeFilterValue([value])}
        />
      );
    } else if (filter.operator === 'is' || filter.operator === 'isNot') {
      filterValueControl = (
        <ComboboxAdvanced
          items={valuesCombobox}
          value={filter.value}
          className="min-w-0 flex-1"
          onChange={changeFilterValue}
          placeholder="Select..."
        />
      );
    } else {
      filterValueControl = (
        <InputEnter
          value={filter.value[0] ? String(filter.value[0]) : ''}
          onChangeValue={(value) => changeFilterValue([value])}
          immediate={immediateInput}
        />
      );
    }
  }

  return (
    <div className={className}>
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <ColorSquare className="bg-emerald-500">
          <SlidersHorizontal size={10} />
        </ColorSquare>
        <div className="flex min-w-0 flex-1">
          <RenderDots truncate>{filter.name}</RenderDots>
        </div>
        <Button className="shrink-0" variant="ghost" size="sm" onClick={removeFilter}>
          <Trash size={16} />
        </Button>
      </div>
      <div className="flex min-w-0 gap-1">
        <FilterOperatorSelect
          value={filter.operator}
          onChange={changeFilterOperator}
          items={epochUnit ? DATE_OPERATOR_ITEMS : undefined}
        />
        {filterValueControl}
      </div>
    </div>
  );
}
