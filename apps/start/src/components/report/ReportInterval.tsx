import { ClockIcon } from 'lucide-react';

import {
  isHourIntervalEnabledByRange,
  isMinuteIntervalEnabledByRange,
} from '@openpanel/constants';

import { cn } from '@/utils/cn';
import type { IChartRange, IChartType, IInterval } from '@openpanel/validation';
import {
  differenceInDays,
  isSameDay,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  subDays,
} from 'date-fns';
import type { IDateConfig } from '@openpanel/validation';
import { Button } from '../ui/button';
import { CommandShortcut } from '../ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

interface ReportIntervalProps {
  className?: string;
  interval: IInterval;
  onChange: (range: IInterval) => void;
  chartType: IChartType;
  range: IChartRange;
  startDate?: string | null;
  endDate?: string | null;
  dateConfig?: IDateConfig;
}
export function ReportInterval({
  className,
  interval,
  onChange,
  chartType,
  range,
  startDate,
  endDate,
  dateConfig,
}: ReportIntervalProps) {
  if (
    chartType !== 'linear' &&
    chartType !== 'histogram' &&
    chartType !== 'area' &&
    chartType !== 'metric' &&
    chartType !== 'retention' &&
    chartType !== 'conversion'
  ) {
    return null;
  }

  let isHourIntervalEnabled = isHourIntervalEnabledByRange(range);
  if (range === 'custom') {
    // Resolve effective dates from dateConfig or fallback to raw dates
    let effectiveStart: Date | undefined;
    let effectiveEnd: Date | undefined;
    const now = new Date();

    if (dateConfig) {
      switch (dateConfig.dateMode) {
        case 'fixed':
          if (dateConfig.fixedStartDate && dateConfig.fixedEndDate) {
            effectiveStart = new Date(dateConfig.fixedStartDate);
            effectiveEnd = new Date(dateConfig.fixedEndDate);
          }
          break;
        case 'last': {
          const amt = dateConfig.lastAmount ?? 7;
          const mult = dateConfig.lastUnit === 'week' ? 7 : dateConfig.lastUnit === 'month' ? 30 : 1;
          const ending = dateConfig.lastEndingDaysAgo ?? 0;
          effectiveEnd = subDays(now, ending);
          effectiveStart = subDays(effectiveEnd, amt * mult);
          break;
        }
        case 'since':
          if (dateConfig.sinceDate) {
            effectiveStart = new Date(dateConfig.sinceDate);
            effectiveEnd = now;
          }
          break;
        case 'period_to_date': {
          const unit = dateConfig.periodToDateUnit ?? 'month';
          effectiveStart =
            unit === 'week' ? startOfWeek(now, { weekStartsOn: 1 })
            : unit === 'quarter' ? startOfQuarter(now)
            : unit === 'year' ? startOfYear(now)
            : startOfMonth(now);
          effectiveEnd = now;
          break;
        }
      }
    }

    if (!effectiveStart && startDate) effectiveStart = new Date(startDate);
    if (!effectiveEnd && endDate) effectiveEnd = new Date(endDate);

    if (effectiveStart && effectiveEnd) {
      isHourIntervalEnabled = differenceInDays(effectiveEnd, effectiveStart) <= 4;
    }
  }

  const items = [
    {
      value: 'minute',
      label: 'Minute',
      disabled: !isMinuteIntervalEnabledByRange(range),
    },
    {
      value: 'hour',
      label: 'Hour',
      disabled: !isHourIntervalEnabled,
    },
    {
      value: 'day',
      label: 'Day',
    },
    {
      value: 'week',
      label: 'Week',
      disabled:
        range === 'today' ||
        range === 'lastHour' ||
        range === '30min' ||
        range === '7d',
    },
    {
      value: 'month',
      label: 'Month',
      disabled: range === 'today' || range === 'lastHour' || range === '30min',
    },
  ];

  const selectedItem = items.find((item) => item.value === interval);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          icon={ClockIcon}
          className={cn('justify-start', className)}
        >
          {items.find((item) => item.value === interval)?.label || 'Interval'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel className="row items-center justify-between">
          Select interval
          {!!selectedItem && (
            <CommandShortcut>{selectedItem?.label}</CommandShortcut>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {items.map((item) => (
            <DropdownMenuItem
              key={item.value}
              onClick={() => onChange(item.value as IInterval)}
              disabled={item.disabled}
            >
              {item.label}
              {item.value === interval && (
                <DropdownMenuShortcut>
                  <ClockIcon className="size-4" />
                </DropdownMenuShortcut>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
