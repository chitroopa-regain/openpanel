import { Button } from '@/components/ui/button';
import { DropdownMenuComposed } from '@/components/ui/dropdown-menu';
import { operators } from '@openpanel/constants';
import type { IChartEventFilterOperator } from '@openpanel/validation';
import { mapKeys } from '@openpanel/validation';

interface FilterOperatorSelectProps {
  value: IChartEventFilterOperator;
  onChange: (operator: IChartEventFilterOperator) => void;
  children?: React.ReactNode;
  items?: Array<{ value: IChartEventFilterOperator; label: string }>;
}

export function FilterOperatorSelect({
  value,
  onChange,
  children,
  items,
}: FilterOperatorSelectProps) {
  const operatorItems =
    items ??
    mapKeys(operators).map((key) => ({
      value: key,
      label: operators[key],
    }));
  const selectedLabel =
    operatorItems.find((item) => item.value === value)?.label ?? operators[value];
  const trigger = children ?? (
    <Button className="whitespace-nowrap" variant="outline">
      {selectedLabel}
    </Button>
  );

  return (
    <DropdownMenuComposed
      contentProps={{
        collisionPadding: 8,
        side: 'bottom',
      }}
      items={operatorItems}
      label="Operator"
      onChange={onChange}
    >
      {trigger}
    </DropdownMenuComposed>
  );
}
