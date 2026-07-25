import { PopoverPortal } from '@radix-ui/react-popover';
import {
  CheckIcon,
  ChevronsUpDown,
  GanttChartIcon,
  LayersIcon,
} from 'lucide-react';
import VirtualList from 'rc-virtual-list';
import * as React from 'react';
import { EventIcon } from '../events/event-icon';
import { EventScreenshotPreview } from '../events/event-screenshot-preview';
import { filterEventSearchItems } from './combobox-events-search';
import { CreateCustomEventDialog } from '@/components/custom-events/create-custom-event-dialog';
import type { ButtonProps } from '@/components/ui/button';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useNumber } from '@/hooks/use-numer-formatter';
import type { RouterOutputs } from '@/trpc/client';
import { cn } from '@/utils/cn';

/**
 * Type-safe ComboboxEvents component that supports both single and multiple selection.
 *
 * @example
 * // Single selection mode (default)
 * <ComboboxEvents<string>
 *   items={events}
 *   value={selectedEvent}
 *   onChange={(event: string) => setSelectedEvent(event)}
 *   placeholder="Select an event"
 * />
 *
 * @example
 * // Multiple selection mode
 * <ComboboxEvents<string, true>
 *   items={events}
 *   value={selectedEvents}
 *   onChange={(events: string[]) => setSelectedEvents(events)}
 *   placeholder="Select events"
 *   multiple={true}
 * />
 */
export interface ComboboxProps<T, TMultiple extends boolean = false> {
  placeholder: string;
  items: RouterOutputs['chart']['events'];
  value: TMultiple extends true ? T[] : T | null | undefined;
  onChange: TMultiple extends true ? (value: T[]) => void : (value: T) => void;
  className?: string;
  searchable?: boolean;
  size?: ButtonProps['size'];
  label?: string;
  align?: 'start' | 'end' | 'center';
  portal?: boolean;
  error?: string;
  disabled?: boolean;
  multiple?: TMultiple;
  maxDisplayItems?: number;
  allowCreateCustomEvent?: boolean;
  onCreateCustomEvent?: (customEvent: { id: string; name: string }) => void;
}

export function ComboboxEvents<
  T extends string,
  TMultiple extends boolean = false,
>({
  placeholder,
  value,
  onChange,
  className,
  searchable,
  size,
  align = 'start',
  portal,
  error,
  disabled,
  items,
  multiple = false as TMultiple,
  maxDisplayItems = 2,
  allowCreateCustomEvent = false,
  onCreateCustomEvent,
}: ComboboxProps<T, TMultiple>) {
  const number = useNumber();
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false);

  const selectedValues = React.useMemo((): T[] => {
    if (multiple) {
      return Array.isArray(value) ? (value as T[]) : value ? [value as T] : [];
    }
    return value ? [value as T] : [];
  }, [value, multiple]);

  function find(value: string) {
    return items.find(
      (item) => item.name.toLowerCase() === value.toLowerCase()
    );
  }

  const current =
    selectedValues.length > 0 && selectedValues[0]
      ? find(selectedValues[0])
      : null;
  const filteredItems = React.useMemo(
    () => filterEventSearchItems(items, search),
    [items, search]
  );

  const handleSelection = (selectedValue: string) => {
    if (multiple) {
      const currentValues = selectedValues;
      const newValues = currentValues.includes(selectedValue as T)
        ? currentValues.filter((v) => v !== selectedValue)
        : [...currentValues, selectedValue as T];
      onChange(newValues as any);
    } else {
      onChange(selectedValue as any);
      setOpen(false);
    }
  };

  const handleCreated = (customEvent: { id: string; name: string }) => {
    onCreateCustomEvent?.(customEvent);
    setCreateDialogOpen(false);
    setOpen(false);
    setSearch('');
  };

  const renderTriggerContent = () => {
    if (selectedValues.length === 0) {
      return placeholder;
    }

    const firstValue = selectedValues[0];
    const item = firstValue ? find(firstValue) : null;
    let label = item?.name || firstValue;

    if (multiple && selectedValues.length > 1) {
      label += ` +${selectedValues.length - 1}`;
    }

    return label;
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn('relative', className)}>
        <PopoverTrigger asChild>
          <Button
            disabled={disabled}
            size={size}
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn(
              'w-full justify-between',
              !!current?.screenshots?.length && 'pr-16',
              !!error && 'border-destructive'
            )}
          >
            <div className="flex min-w-0 flex-1 items-center">
              {'isCustomEvent' in (current ?? {}) && current?.isCustomEvent ? (
                <LayersIcon className="mr-2 h-4 w-4 shrink-0 text-violet-500" />
              ) : current?.meta ? (
                <EventIcon
                  name={current.name}
                  meta={current.meta as any}
                  size="xs"
                  className="mr-2 shrink-0"
                />
              ) : (
                <GanttChartIcon size={16} className="mr-2 shrink-0" />
              )}
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                {renderTriggerContent()}
              </span>
            </div>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        {!!current?.screenshots?.length && (
          <EventScreenshotPreview
            className="absolute top-1/2 right-8 -translate-y-1/2"
            compact
            eventName={current.name}
            screenshots={current.screenshots}
          />
        )}
      </div>
      <PopoverPortal>
        <PopoverContent
          className="z-[60] w-full max-w-[33em] max-sm:max-w-[100vw] p-0"
          align={align}
          portal={portal}
        >
          <Command shouldFilter={false}>
            {searchable === true && (
              <CommandInput
                placeholder="Search event..."
                value={search}
                onValueChange={setSearch}
              />
            )}
            {allowCreateCustomEvent && (
              <button
                type="button"
                className="flex w-full items-center border-b px-3 py-2 text-sm font-medium text-left transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={() => setCreateDialogOpen(true)}
              >
                Create custom event
              </button>
            )}

            <CommandEmpty>No events found</CommandEmpty>
            <VirtualList
              height={300}
              data={filteredItems}
              itemHeight={32}
              itemKey="value"
              className="w-[33em] max-sm:max-w-[100vw]"
            >
              {(item) => {
                return (
                  <CommandItem
                    className={cn(
                      'p-4 py-2.5 gap-4',
                      selectedValues.includes(item.name as T) && 'bg-accent'
                    )}
                    key={item.name}
                    value={item.name}
                    onSelect={(currentValue) => {
                      handleSelection(item.name);
                    }}
                  >
                    {selectedValues.includes(item.name as T) ? (
                      <CheckIcon className="h-4 w-4 flex-shrink-0" />
                    ) : 'isCustomEvent' in item && item.isCustomEvent ? (
                      <LayersIcon className="h-4 w-4 flex-shrink-0 text-violet-500" />
                    ) : (
                      <EventIcon name={item.name} meta={item.meta} size="sm" />
                    )}
                    <span className="font-medium flex-1 truncate">
                      {item.name === '*' ? 'Any events' : item.name}
                    </span>
                    {(!!item.screenshots?.length ||
                      ('screenshotContextRequested' in item &&
                        item.screenshotContextRequested)) && (
                      <EventScreenshotPreview
                        compact
                        eventName={item.name}
                        screenshots={item.screenshots}
                        showNoMatch={
                          'screenshotContextRequested' in item &&
                          item.screenshotContextRequested === true
                        }
                      />
                    )}
                    {'isCustomEvent' in item && item.isCustomEvent && (
                      <span className="text-xs text-violet-500 font-medium">
                        Custom
                      </span>
                    )}
                    <span className="text-muted-foreground font-mono font-medium">
                      {!('isCustomEvent' in item && item.isCustomEvent) &&
                        number.short(item.count)}
                    </span>
                  </CommandItem>
                );
              }}
            </VirtualList>
          </Command>
        </PopoverContent>
      </PopoverPortal>
      <CreateCustomEventDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={handleCreated}
      />
    </Popover>
  );
}
