import { Columns2Icon, PanelBottomIcon, PanelTopIcon } from 'lucide-react';
import { changeDisplayMode } from './reportSlice';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useDispatch, useSelector } from '@/redux';

const choices = [
  { value: 'both', label: 'Show chart and table', Icon: Columns2Icon },
  { value: 'chart', label: 'Show chart only', Icon: PanelTopIcon },
  { value: 'table', label: 'Show table only', Icon: PanelBottomIcon },
] as const;

export function ReportDisplayMode() {
  const dispatch = useDispatch();
  const value = useSelector(
    (state) => state.report.options?.displayMode ?? 'both'
  );

  return (
    <ToggleGroup
      aria-label="Report display"
      className="w-fit rounded-lg border bg-card p-1"
      onValueChange={(nextValue) => {
        if (nextValue) {
          dispatch(
            changeDisplayMode(nextValue as (typeof choices)[number]['value'])
          );
        }
      }}
      type="single"
      value={value}
    >
      {choices.map(({ value: choice, label, Icon }) => (
        <ToggleGroupItem
          aria-label={label}
          className="h-8 w-8 p-0 text-muted-foreground data-[state=on]:bg-def-200 data-[state=on]:text-foreground data-[state=on]:shadow-sm dark:data-[state=on]:bg-def-800"
          key={choice}
          title={label}
          value={choice}
        >
          <Icon className="h-4 w-4" />
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
