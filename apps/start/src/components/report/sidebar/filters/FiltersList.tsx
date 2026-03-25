import type { IChartCustomEvent, IChartEvent } from '@openpanel/validation';

import { FilterItem } from './FilterItem';

interface ReportEventFiltersProps {
  event: IChartEvent | IChartCustomEvent;
}

export function FiltersList({ event }: ReportEventFiltersProps) {
  const filters = event.filters ?? [];
  if (filters.length === 0) return null;
  return (
    <div>
      <div className="bg-def-100 flex flex-col divide-y overflow-hidden rounded-b-md">
        {filters.map((filter) => {
          return <FilterItem key={filter.name} filter={filter} event={event} />;
        })}
      </div>
    </div>
  );
}
