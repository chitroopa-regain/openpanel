import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { pushModal, useOnPushModal } from '@/modals';
import { cn } from '@/utils/cn';
import { bind } from 'bind-event-listener';
import { CalendarIcon } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';

import { shouldIgnoreKeypress } from '@/utils/should-ignore-keypress';
import { timeWindows } from '@openpanel/constants';
import type { IChartRange, IDateConfig } from '@openpanel/validation';
import type { DateRangerPickerPayload } from '@/modals/date-ranger-picker';
import { endOfDay, format, isSameDay, parseISO, startOfDay } from 'date-fns';

type Props = {
  value: IChartRange;
  onChange: (value: IChartRange) => void;
  onStartDateChange: (date: string) => void;
  onEndDateChange: (date: string) => void;
  endDate: string | null;
  startDate: string | null;
  className?: string;
  dateConfig?: IDateConfig;
  onDateConfigChange?: (config: IDateConfig) => void;
};
export function TimeWindowPicker({
  value,
  onChange,
  startDate,
  onStartDateChange,
  endDate,
  onEndDateChange,
  className,
  dateConfig,
  onDateConfigChange,
}: Props) {
  const isDateRangerPickerOpen = useRef(false);
  useOnPushModal('DateRangerPicker', (open) => {
    isDateRangerPickerOpen.current = open;
  });
  const timeWindow = timeWindows[value ?? '30d'];

  const handleCustom = useCallback(() => {
    pushModal('DateRangerPicker', {
      onChange: ({ startDate, endDate, dateMode, fixedStartDate, fixedEndDate, lastAmount, lastUnit, lastEndingDaysAgo, sinceDate, periodToDateUnit }: DateRangerPickerPayload) => {
        // Only set concrete startDate/endDate for fixed mode.
        // Relative modes (last/since/period_to_date) resolve from dateConfig at query time.
        if (startDate && endDate) {
          onStartDateChange(format(startOfDay(startDate), 'yyyy-MM-dd HH:mm:ss'));
          onEndDateChange(format(endOfDay(endDate), 'yyyy-MM-dd HH:mm:ss'));
        }
        onChange('custom');
        onDateConfigChange?.({
          dateMode,
          fixedStartDate,
          fixedEndDate,
          lastAmount,
          lastUnit,
          lastEndingDaysAgo,
          sinceDate,
          periodToDateUnit,
        });
      },
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      dateMode: dateConfig?.dateMode,
      fixedStartDate: dateConfig?.fixedStartDate,
      fixedEndDate: dateConfig?.fixedEndDate,
      lastAmount: dateConfig?.lastAmount,
      lastUnit: dateConfig?.lastUnit,
      lastEndingDaysAgo: dateConfig?.lastEndingDaysAgo,
      sinceDate: dateConfig?.sinceDate,
      periodToDateUnit: dateConfig?.periodToDateUnit,
    });
  }, [startDate, endDate, dateConfig]);

  useEffect(() => {
    return bind(document, {
      type: 'keydown',
      listener(event) {
        if (shouldIgnoreKeypress(event)) {
          return;
        }

        if (isDateRangerPickerOpen.current) {
          return;
        }

        const match = Object.values(timeWindows).find(
          (tw) => event.key === tw.shortcut.toLowerCase(),
        );
        if (match?.key === 'custom') {
          handleCustom();
        } else if (match) {
          onChange(match.key);
        }
      },
    });
  }, [handleCustom]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          icon={CalendarIcon}
          className={cn('justify-start', className)}
        >
          <span className="truncate">
            {value === 'custom' && dateConfig
              ? dateConfig.dateMode === 'fixed' && dateConfig.fixedStartDate && dateConfig.fixedEndDate
                ? `${format(parseISO(dateConfig.fixedStartDate), 'MMM d')} – ${format(parseISO(dateConfig.fixedEndDate), 'MMM d')}`
                : dateConfig.dateMode === 'last' && dateConfig.lastAmount
                  ? `Last ${dateConfig.lastAmount} ${dateConfig.lastUnit === 'week' ? 'weeks' : dateConfig.lastUnit === 'month' ? 'months' : 'days'}`
                  : dateConfig.dateMode === 'period_to_date' && dateConfig.periodToDateUnit
                    ? `${dateConfig.periodToDateUnit.charAt(0).toUpperCase()}${dateConfig.periodToDateUnit.slice(1)} to date`
                    : dateConfig.dateMode === 'since' && dateConfig.sinceDate
                      ? `Since ${format(parseISO(dateConfig.sinceDate), "MMM d,''yy")}`
                      : startDate
                        ? `Since ${format(new Date(startDate), "MMM d,''yy")}`
                        : 'Custom'
              : value === 'custom' && startDate
                ? `Since ${format(new Date(startDate), "MMM d,''yy")}`
                : (timeWindow?.label ?? 'Select date')}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        <DropdownMenuLabel>Time window</DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onChange(timeWindows['30min'].key)}>
            {timeWindows['30min'].label}
            <DropdownMenuShortcut>
              {timeWindows['30min'].shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange(timeWindows.lastHour.key)}>
            {timeWindows.lastHour.label}
            <DropdownMenuShortcut>
              {timeWindows.lastHour.shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange(timeWindows.today.key)}>
            {timeWindows.today.label}
            <DropdownMenuShortcut>
              {timeWindows.today.shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange(timeWindows.yesterday.key)}>
            {timeWindows.yesterday.label}
            <DropdownMenuShortcut>
              {timeWindows.yesterday.shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onChange(timeWindows['7d'].key)}>
            {timeWindows['7d'].label}
            <DropdownMenuShortcut>
              {timeWindows['7d'].shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange(timeWindows['30d'].key)}>
            {timeWindows['30d'].label}
            <DropdownMenuShortcut>
              {timeWindows['30d'].shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange(timeWindows['6m'].key)}>
            {timeWindows['6m'].label}
            <DropdownMenuShortcut>
              {timeWindows['6m'].shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange(timeWindows['12m'].key)}>
            {timeWindows['12m'].label}
            <DropdownMenuShortcut>
              {timeWindows['12m'].shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() => onChange(timeWindows.monthToDate.key)}
          >
            {timeWindows.monthToDate.label}
            <DropdownMenuShortcut>
              {timeWindows.monthToDate.shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange(timeWindows.lastMonth.key)}>
            {timeWindows.lastMonth.label}
            <DropdownMenuShortcut>
              {timeWindows.lastMonth.shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() => onChange(timeWindows.yearToDate.key)}
          >
            {timeWindows.yearToDate.label}
            <DropdownMenuShortcut>
              {timeWindows.yearToDate.shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onChange(timeWindows.lastYear.key)}>
            {timeWindows.lastYear.label}
            <DropdownMenuShortcut>
              {timeWindows.lastYear.shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => handleCustom()}>
            {timeWindows.custom.label}
            <DropdownMenuShortcut>
              {timeWindows.custom.shortcut}
            </DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
