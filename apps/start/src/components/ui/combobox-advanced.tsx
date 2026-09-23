import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { ChevronsUpDownIcon } from 'lucide-react';
import VirtualList from 'rc-virtual-list';
import * as React from 'react';

import { Button, type ButtonProps } from './button';
import { DumpCheckbox } from './checkbox';
import {
  Popover,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from './popover';

type IValue = any;
type IItem = Record<'value' | 'label', IValue>;

// cmdk uses values in DOM selectors and normalizes their case/whitespace.
// Give it an opaque, reversible-free identity; filter values stay raw literals.
const commandValue = (value: IValue) =>
  `value-${Array.from(`${typeof value}:${String(value)}`, (char) =>
    char.codePointAt(0)!.toString(16)
  ).join('-')}`;

interface ComboboxAdvancedProps {
  value: IValue[];
  onChange: (value: IValue[]) => void;
  items: IItem[];
  placeholder?: string;
  className?: string;
  size?: ButtonProps['size'];
  children?: React.ReactNode;
  allowCustomValue?: boolean;
}

export function ComboboxAdvanced({
  items,
  value,
  onChange,
  placeholder,
  className,
  size,
  children,
  allowCustomValue = false,
}: ComboboxAdvancedProps) {
  const [open, setOpen] = React.useState(false);
  const [inputValue, setInputValue] = React.useState('');

  const matchesQuery = React.useCallback(
    (item: IItem, q: string) =>
      !q ||
      (typeof item.label === 'string' &&
        item.label.toLowerCase().includes(q)) ||
      (typeof item.value === 'string' && item.value.toLowerCase().includes(q)),
    []
  );

  const uniqueItems = React.useMemo(() => {
    const seen = new Set<IValue>();
    return items.filter((item) => {
      if (seen.has(item.value)) return false;
      seen.add(item.value);
      return true;
    });
  }, [items]);
  const matchingItems = uniqueItems.filter((item) =>
    matchesQuery(
      item,
      (allowCustomValue ? inputValue.trim() : inputValue).toLowerCase()
    )
  );
  const matchingValues = matchingItems.map((i) => i.value);
  const matchingCount = matchingItems.length;
  const allMatchingSelected =
    matchingValues.length > 0 && matchingValues.every((v) => value.includes(v));
  const someMatchingSelected = matchingValues.some((v) => value.includes(v));

  const toggleSelectAll = React.useCallback(() => {
    if (allMatchingSelected) {
      const matchingSet = new Set(matchingValues);
      onChange(value.filter((v) => !matchingSet.has(v)));
    } else {
      onChange(Array.from(new Set([...value, ...matchingValues])));
    }
  }, [allMatchingSelected, matchingValues, value, onChange]);

  const selectables = matchingItems.filter(
    (item) => !value.includes(item.value)
  );
  // Filter persistence and SQL already trim boundaries. Show the exact value
  // that will be applied instead of displaying a whitespace-sensitive literal.
  const customValue = inputValue.trim();
  const canSpecify =
    allowCustomValue &&
    customValue.length > 0 &&
    !items.some((item) => item.value === customValue) &&
    !value.includes(customValue);

  const renderItem = (item: IItem) => {
    const checked = value.includes(item.value);
    return (
      <CommandItem
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onSelect={() => {
          onChange(
            checked
              ? value.filter((s) => s !== item.value)
              : Array.from(new Set([...value, item.value]))
          );
        }}
        className={'flex cursor-pointer items-center gap-2'}
        value={commandValue(item.value)}
      >
        <DumpCheckbox checked={checked} />
        {item.label ?? item.value}
      </CommandItem>
    );
  };

  const data = React.useMemo(() => {
    return [
      ...Array.from(new Set(value)).map((val) => {
        const item = items.find((item) => item.value === val);
        return item
          ? { value: val, label: item.label }
          : { value: val, label: val };
      }),
      ...selectables,
    ];
  }, [selectables, items, value]);

  const trigger = children ?? (
    <Button variant={'outline'} className={className} size={size} autoHeight>
      <div className="flex w-full flex-wrap gap-1">
        {value.length === 0 && placeholder}
        {value.map((val) => {
          const item = items.find((item) => item.value === val) ?? {
            value: val,
            label: val,
          };
          return <Badge key={String(item.value)}>{item.label}</Badge>;
        })}
      </div>
      <ChevronsUpDownIcon className="ml-2 h-4 w-4 shrink-0 opacity-50" />
    </Button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverPortal>
        <PopoverContent className="w-full max-w-md p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search"
              value={inputValue}
              onValueChange={setInputValue}
            />
            {matchingCount > 0 && (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={toggleSelectAll}
                className="flex w-full cursor-pointer items-center gap-2 border-b px-3 py-2 text-left text-sm text-primary hover:bg-accent"
              >
                <DumpCheckbox
                  checked={
                    allMatchingSelected
                      ? true
                      : someMatchingSelected
                        ? 'indeterminate'
                        : false
                  }
                />
                <span>
                  {inputValue
                    ? `Select all matching (${matchingCount})`
                    : `Select all (${matchingCount})`}
                </span>
              </button>
            )}
            <CommandList>
              {canSpecify && (
                <CommandItem
                  value={`specify-${commandValue(customValue)}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onSelect={() =>
                    onChange(Array.from(new Set([...value, customValue])))
                  }
                  className="flex cursor-pointer items-center gap-2"
                >
                  <DumpCheckbox checked={false} />
                  <span className="whitespace-pre-wrap">
                    Specify: {customValue}
                  </span>
                </CommandItem>
              )}
              <VirtualList
                height={Math.min(data.length * 32, 300)}
                data={data}
                itemHeight={32}
                itemKey="value"
              >
                {renderItem}
              </VirtualList>
            </CommandList>
          </Command>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
