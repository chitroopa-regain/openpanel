import { format } from 'date-fns';
import { CalendarIcon } from 'lucide-react';
import type { EpochUnit } from './epoch-date-filter.utils';
import { dateToEpochValue, epochValueToDate } from './epoch-date-filter.utils';
import { Button } from '@/components/ui/button';
import { pushModal } from '@/modals';

export function EpochDateFilterValue({
  value,
  unit,
  onChange,
}: {
  value: unknown;
  unit: EpochUnit;
  onChange: (value: string) => void;
}) {
  const selectedDate = epochValueToDate(value, unit);

  return (
    <Button
      className="min-w-0 flex-1 justify-start gap-2 overflow-hidden px-3 font-normal"
      onClick={() =>
        pushModal('DateTimePicker', {
          initialDate: selectedDate ?? new Date(),
          title: 'Select date and time',
          onChange: (date: Date) => onChange(dateToEpochValue(date, unit)),
        })
      }
      variant="outline"
    >
      <CalendarIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">
        {selectedDate
          ? format(selectedDate, 'MMM d, yyyy, HH:mm')
          : 'Select date and time'}
      </span>
    </Button>
  );
}
