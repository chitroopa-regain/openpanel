import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Switch } from '@/components/ui/switch';
import { useBreakpoint } from '@/hooks/use-breakpoint';
import {
  addDays,
  format,
  isSameDay,
  parseISO,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  startOfYear,
  subDays,
  subMonths,
  subWeeks,
} from 'date-fns';
import { useState } from 'react';

import { CheckIcon, RotateCcwIcon, XIcon } from 'lucide-react';
import { popModal } from '.';
import { ModalContent } from './Modal/Container';

// Resolve "Last N <unit>" start from an end date. Months are calendar
// months, not a 30-day approximation — must match the backend resolver in
// packages/db/src/services/chart.service.ts (getChartStartEndDate).
function subtractLastWindow(end: Date, amount: number, unit: string | null | undefined): Date {
  if (unit === 'week') return subWeeks(end, amount);
  if (unit === 'month') return subMonths(end, amount);
  return subDays(end, amount);
}

type DateMode = 'fixed' | 'last' | 'since' | 'period_to_date';

export type DateRangerPickerPayload = {
  startDate?: Date;
  endDate?: Date;
  dateMode: DateMode;
  fixedStartDate?: string;
  fixedEndDate?: string;
  lastAmount?: number;
  lastUnit?: string;
  lastEndingDaysAgo?: number;
  sinceDate?: string;
  periodToDateUnit?: string;
  enableTimeRanges?: boolean;
};

type Props = {
  onChange: (payload: DateRangerPickerPayload) => void;
  startDate?: Date;
  endDate?: Date;
  dateMode?: DateMode;
  fixedStartDate?: string;
  fixedEndDate?: string;
  lastAmount?: number;
  lastUnit?: string;
  lastEndingDaysAgo?: number;
  sinceDate?: string;
  periodToDateUnit?: string;
  enableTimeRanges?: boolean;
};

// Format a Date as a local "yyyy-MM-ddTHH:mm:ss" string suitable for a
// datetime-local input or for storage in fixedStartDate/fixedEndDate when
// time ranges are enabled.
function formatLocalDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Merge calendar-picked date with existing time-of-day, so clicking a new
// day on the calendar does not reset the user's selected time.
function mergeDateWithTime(datePart: Date, timeSource: Date | undefined): Date {
  const out = new Date(datePart);
  if (timeSource) {
    out.setHours(timeSource.getHours(), timeSource.getMinutes(), timeSource.getSeconds(), 0);
  } else {
    out.setHours(0, 0, 0, 0);
  }
  return out;
}

const modes: { key: DateMode; label: string }[] = [
  { key: 'fixed', label: 'Fixed' },
  { key: 'last', label: 'Last' },
  { key: 'since', label: 'Since' },
  { key: 'period_to_date', label: 'Period to date' },
];

const lastUnits = [
  { value: 'day', label: 'days' },
  { value: 'week', label: 'weeks' },
  { value: 'month', label: 'months' },
];

const periodUnits = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
];

function inferMode(props: Props): DateMode {
  if (props.dateMode) return props.dateMode;
  // Only infer from explicit config fields, not from date heuristics
  if (props.lastAmount) return 'last';
  if (props.periodToDateUnit) return 'period_to_date';
  if (props.sinceDate) return 'since';
  return 'fixed';
}

function resolvePeriodStart(unit: string): Date {
  const now = new Date();
  switch (unit) {
    case 'week':
      return startOfWeek(now, { weekStartsOn: 1 });
    case 'month':
      return startOfMonth(now);
    case 'quarter':
      return startOfQuarter(now);
    case 'year':
      return startOfYear(now);
    default:
      return startOfMonth(now);
  }
}

export default function DateRangerPicker(props: Props) {
  const { onChange } = props;
  const { isBelowSm } = useBreakpoint('sm');

  const [mode, setMode] = useState<DateMode>(inferMode(props));

  // Fixed mode — parseISO treats YYYY-MM-DD as local date (not UTC)
  const [fixedStart, setFixedStart] = useState<Date | undefined>(
    props.fixedStartDate
      ? parseISO(props.fixedStartDate)
      : props.startDate,
  );
  const [fixedEnd, setFixedEnd] = useState<Date | undefined>(
    props.fixedEndDate
      ? parseISO(props.fixedEndDate)
      : props.endDate,
  );

  // Last mode
  const [lastAmount, setLastAmount] = useState(props.lastAmount ?? 7);
  const [lastUnit, setLastUnit] = useState(props.lastUnit ?? 'day');
  const [lastEndingDaysAgo, setLastEndingDaysAgo] = useState(
    (props as any).lastEndingDaysAgo ?? 0,
  );

  // Since mode — parseISO treats YYYY-MM-DD as local date (not UTC)
  const [sinceDate, setSinceDate] = useState<Date | undefined>(
    props.sinceDate
      ? parseISO(props.sinceDate)
      : props.startDate,
  );

  // Period to date
  const [periodUnit, setPeriodUnit] = useState(
    props.periodToDateUnit ?? 'month',
  );

  // Time ranges toggle — when on, fixed/since inputs include time-of-day
  const [enableTimeRanges, setEnableTimeRanges] = useState(
    props.enableTimeRanges ?? false,
  );

  const canApply = (() => {
    switch (mode) {
      case 'fixed':
        return !!(fixedStart && fixedEnd);
      case 'last':
        return lastAmount > 0;
      case 'since':
        return !!sinceDate;
      case 'period_to_date':
        return !!periodUnit;
    }
  })();

  const handleApply = () => {
    const now = new Date();
    switch (mode) {
      case 'fixed':
        if (fixedStart && fixedEnd) {
          popModal();
          onChange({
            startDate: fixedStart,
            endDate: fixedEnd,
            dateMode: 'fixed',
            fixedStartDate: enableTimeRanges
              ? formatLocalDateTime(fixedStart)
              : `${fixedStart.getFullYear()}-${String(fixedStart.getMonth() + 1).padStart(2, '0')}-${String(fixedStart.getDate()).padStart(2, '0')}`,
            fixedEndDate: enableTimeRanges
              ? formatLocalDateTime(fixedEnd)
              : `${fixedEnd.getFullYear()}-${String(fixedEnd.getMonth() + 1).padStart(2, '0')}-${String(fixedEnd.getDate()).padStart(2, '0')}`,
            enableTimeRanges,
          });
        }
        break;
      case 'last': {
        popModal();
        onChange({
          dateMode: 'last',
          lastAmount,
          lastUnit,
          lastEndingDaysAgo,
        });
        break;
      }
      case 'since':
        if (sinceDate) {
          popModal();
          onChange({
            dateMode: 'since',
            sinceDate: enableTimeRanges
              ? formatLocalDateTime(sinceDate)
              : `${sinceDate.getFullYear()}-${String(sinceDate.getMonth() + 1).padStart(2, '0')}-${String(sinceDate.getDate()).padStart(2, '0')}`,
            enableTimeRanges,
          });
        }
        break;
      case 'period_to_date': {
        popModal();
        onChange({
          dateMode: 'period_to_date',
          periodToDateUnit: periodUnit,
        });
        break;
      }
    }
  };

  // Preview dates for display
  const previewDates = (() => {
    const now = new Date();
    switch (mode) {
      case 'fixed': {
        const fmt = enableTimeRanges ? 'MMM d, yyyy, h:mm a' : 'MMM d, yyyy';
        return {
          label1: 'Starts',
          value1: fixedStart ? format(fixedStart, fmt) : null,
          label2: 'Ends',
          value2: fixedEnd ? format(fixedEnd, fmt) : null,
        };
      }
      case 'last': {
        if (lastAmount <= 0) {
          return { label1: 'From', value1: null, label2: 'To', value2: null };
        }
        const end = subDays(now, lastEndingDaysAgo);
        const start = subtractLastWindow(end, lastAmount, lastUnit);
        return {
          label1: 'From',
          value1: format(start, 'MMM d, yyyy'),
          label2: 'To',
          value2: lastEndingDaysAgo === 0
            ? 'Today'
            : format(end, 'MMM d, yyyy'),
        };
      }
      case 'since':
        return {
          label1: 'Since',
          value1: sinceDate
            ? format(sinceDate, enableTimeRanges ? 'MMM d, yyyy, h:mm a' : 'MMM d, yyyy')
            : null,
          label2: 'To',
          value2: 'Today',
        };
      case 'period_to_date': {
        const start = resolvePeriodStart(periodUnit);
        return {
          label1: 'From',
          value1: format(start, 'MMM d, yyyy'),
          label2: 'To',
          value2: 'Today',
        };
      }
    }
  })();

  return (
    <ModalContent className="p-0 min-w-fit max-w-[720px]">
      <div className="flex flex-col md:flex-row">
        {/* Left mode rail */}
        <div className="flex md:flex-col gap-1 p-3 md:p-4 md:border-r border-b md:border-b-0 border-border md:min-w-[170px] shrink-0">
          <div className="text-xs font-medium text-muted-foreground mb-1 hidden md:block">
            Date mode
          </div>
          {modes.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`flex items-center justify-between gap-2 px-3 py-1.5 text-sm transition-colors border-l-2 ${
                mode === m.key
                  ? 'border-primary text-primary font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setMode(m.key)}
            >
              {m.label}
              {mode === m.key && (
                <CheckIcon className="size-3.5 shrink-0" />
              )}
            </button>
          ))}
        </div>

        {/* Right content */}
        <div className="flex-1 p-4 md:p-6 col gap-4">
          {/* Date fields — shown for Fixed and Since modes only */}
          {(mode === 'fixed' || mode === 'since') && (
            <div className="flex flex-col sm:flex-row gap-3 items-end">
              <div className="flex-1 w-full">
                <div className="text-xs text-muted-foreground mb-1">
                  {previewDates.label1}
                </div>
                {enableTimeRanges && mode === 'fixed' ? (
                  <input
                    type="datetime-local"
                    step={60}
                    value={fixedStart ? formatLocalDateTime(fixedStart).slice(0, 16) : ''}
                    onChange={(e) => {
                      if (!e.target.value) {
                        setFixedStart(undefined);
                        return;
                      }
                      const d = new Date(e.target.value);
                      if (!Number.isNaN(d.getTime())) setFixedStart(d);
                    }}
                    className="w-full rounded border border-border bg-card px-3 py-1.5 text-sm font-mono min-h-[32px]"
                  />
                ) : enableTimeRanges && mode === 'since' ? (
                  <input
                    type="datetime-local"
                    step={60}
                    value={sinceDate ? formatLocalDateTime(sinceDate).slice(0, 16) : ''}
                    onChange={(e) => {
                      if (!e.target.value) {
                        setSinceDate(undefined);
                        return;
                      }
                      const d = new Date(e.target.value);
                      if (!Number.isNaN(d.getTime())) setSinceDate(d);
                    }}
                    className="w-full rounded border border-border bg-card px-3 py-1.5 text-sm font-mono min-h-[32px]"
                  />
                ) : (
                  <div className="rounded border border-border bg-card px-3 py-1.5 text-sm font-mono min-h-[32px]">
                    {previewDates.value1 ?? (
                      <span className="text-muted-foreground">Select date</span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex-1 w-full">
                <div className="text-xs text-muted-foreground mb-1">
                  {previewDates.label2}
                </div>
                {enableTimeRanges && mode === 'fixed' ? (
                  <input
                    type="datetime-local"
                    step={60}
                    value={fixedEnd ? formatLocalDateTime(fixedEnd).slice(0, 16) : ''}
                    onChange={(e) => {
                      if (!e.target.value) {
                        setFixedEnd(undefined);
                        return;
                      }
                      const d = new Date(e.target.value);
                      if (!Number.isNaN(d.getTime())) setFixedEnd(d);
                    }}
                    className="w-full rounded border border-border bg-card px-3 py-1.5 text-sm font-mono min-h-[32px]"
                  />
                ) : (
                  <div className="rounded border border-border bg-card px-3 py-1.5 text-sm font-mono min-h-[32px]">
                    {previewDates.value2 ?? (
                      <span className="text-muted-foreground">
                        {mode === 'since' ? 'Today' : 'Select date'}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Mode-specific controls — replace date fields for Last and Period to date */}
          {mode === 'last' && (
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <div className="text-xs text-muted-foreground mb-1">Last</div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    value={lastAmount || ''}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setLastAmount(Number.isNaN(v) ? 0 : v);
                    }}
                    className="w-20 rounded border border-border bg-card px-3 py-1.5 text-sm font-mono"
                  />
                  <select
                    value={lastUnit}
                    onChange={(e) => setLastUnit(e.target.value)}
                    className="rounded border border-border bg-card px-3 py-1.5 text-sm"
                  >
                    {lastUnits.map((u) => (
                      <option key={u.value} value={u.value}>
                        {u.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex-1">
                <div className="text-xs text-muted-foreground mb-1">Ending</div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    value={lastEndingDaysAgo}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setLastEndingDaysAgo(Number.isNaN(v) ? 0 : v);
                    }}
                    className="w-20 rounded border border-border bg-card px-3 py-1.5 text-sm font-mono"
                  />
                  <span className="text-sm text-muted-foreground whitespace-nowrap">days ago</span>
                </div>
              </div>
            </div>
          )}

          {mode === 'period_to_date' && (
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <div className="text-xs text-muted-foreground mb-1">This</div>
                <select
                  value={periodUnit}
                  onChange={(e) => setPeriodUnit(e.target.value)}
                  className="w-full rounded border border-border bg-card px-3 py-1.5 text-sm"
                >
                  {periodUnits.map((u) => (
                    <option key={u.value} value={u.value}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <div className="text-xs text-muted-foreground mb-1">To</div>
                <div className="rounded border border-border bg-card px-3 py-1.5 text-sm font-mono min-h-[32px]">
                  Today
                </div>
              </div>
            </div>
          )}

          {/* Calendar — always visible, mode determines interaction */}
          {mode === 'fixed' ? (
            <Calendar
              captionLayout="dropdown" showOutsideDays={false} fixedWeeks
              initialFocus
              mode="range"
              defaultMonth={subMonths(
                fixedStart ?? new Date(),
                isBelowSm ? 0 : 1,
              )}
              selected={{ from: fixedStart, to: fixedEnd }}
              toDate={new Date()}
              onSelect={(range) => {
                if (range?.from) {
                  setFixedStart(
                    enableTimeRanges
                      ? mergeDateWithTime(range.from, fixedStart)
                      : range.from,
                  );
                }
                if (range?.to) {
                  setFixedEnd(
                    enableTimeRanges
                      ? mergeDateWithTime(
                          range.to,
                          fixedEnd ?? new Date(
                            range.to.getFullYear(),
                            range.to.getMonth(),
                            range.to.getDate(),
                            23, 59, 0,
                          ),
                        )
                      : range.to,
                  );
                } else {
                  setFixedEnd(undefined);
                }
              }}
              numberOfMonths={isBelowSm ? 1 : 2}
              className="mx-auto min-h-[370px] [&_table]:mx-auto [&_table]:w-auto p-0 pt-2"
            />
          ) : mode === 'since' ? (
            <Calendar
              captionLayout="dropdown" showOutsideDays={false} fixedWeeks
              initialFocus
              mode="range"
              defaultMonth={subMonths(
                sinceDate ?? new Date(),
                isBelowSm ? 0 : 1,
              )}
              selected={sinceDate ? { from: sinceDate, to: new Date() } : undefined}
              toDate={new Date()}
              onSelect={(range) => {
                if (range?.from) {
                  setSinceDate(
                    enableTimeRanges
                      ? mergeDateWithTime(range.from, sinceDate)
                      : range.from,
                  );
                }
              }}
              numberOfMonths={isBelowSm ? 1 : 2}
              className="mx-auto min-h-[370px] [&_table]:mx-auto [&_table]:w-auto p-0 pt-2"
            />
          ) : mode === 'last' ? (
            <Calendar
              key={`last-${lastAmount}-${lastUnit}`}
              captionLayout="dropdown" showOutsideDays={false} fixedWeeks
              mode="range"
              defaultMonth={(() => {
                if (lastAmount <= 0) return subMonths(new Date(), isBelowSm ? 0 : 1);
                const end = subDays(new Date(), lastEndingDaysAgo);
                return subMonths(
                  subtractLastWindow(end, lastAmount, lastUnit),
                  isBelowSm ? 0 : 1,
                );
              })()}
              selected={lastAmount > 0 ? {
                from: subtractLastWindow(
                  subDays(new Date(), lastEndingDaysAgo),
                  lastAmount,
                  lastUnit,
                ),
                to: subDays(new Date(), lastEndingDaysAgo),
              } : undefined}
              toDate={new Date()}
              numberOfMonths={isBelowSm ? 1 : 2}
              className="mx-auto min-h-[370px] [&_table]:mx-auto [&_table]:w-auto p-0 pt-2 [&_td]:pointer-events-none [&_td]:opacity-70"
            />
          ) : (
            <Calendar
              key={`period-${periodUnit}`}
              captionLayout="dropdown" showOutsideDays={false} fixedWeeks
              mode="range"
              defaultMonth={subMonths(resolvePeriodStart(periodUnit), isBelowSm ? 0 : 1)}
              selected={{
                from: resolvePeriodStart(periodUnit),
                to: new Date(),
              }}
              toDate={new Date()}
              numberOfMonths={isBelowSm ? 1 : 2}
              className="mx-auto min-h-[370px] [&_table]:mx-auto [&_table]:w-auto p-0 pt-2 [&_td]:pointer-events-none [&_td]:opacity-70"
            />
          )}

          {/* Actions */}
          <div className="col flex-col-reverse md:row gap-2 items-center">
            {(mode === 'fixed' || mode === 'since') && (
              <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer md:mr-auto">
                <Switch
                  checked={enableTimeRanges}
                  onCheckedChange={(checked) => {
                    setEnableTimeRanges(checked);
                    // When enabling: default end-of-day time = 23:59 if the
                    // current fixedEnd is at exactly midnight (the natural
                    // date-only default).
                    if (checked && fixedEnd) {
                      const e = new Date(fixedEnd);
                      if (e.getHours() === 0 && e.getMinutes() === 0 && e.getSeconds() === 0) {
                        e.setHours(23, 59, 0, 0);
                        setFixedEnd(e);
                      }
                    }
                  }}
                />
                Enable Time Ranges
              </label>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={() => popModal()}
              icon={XIcon}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="ghost"
              title="Reset selection and navigation to default"
              onClick={() => {
                if (mode === 'fixed') {
                  setFixedStart(undefined);
                  setFixedEnd(undefined);
                } else if (mode === 'since') {
                  setSinceDate(undefined);
                } else if (mode === 'last') {
                  setLastAmount(0);
                }
              }}
              icon={RotateCcwIcon}
            >
              Reset
            </Button>
            <Button
              type="button"
              className="md:ml-auto"
              disabled={!canApply}
              onClick={handleApply}
              icon={CheckIcon}
            >
              Apply
            </Button>
          </div>
        </div>
      </div>
    </ModalContent>
  );
}
