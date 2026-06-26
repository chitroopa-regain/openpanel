import { Button } from '@/components/ui/button';
import { DropdownMenuComposed } from '@/components/ui/dropdown-menu';
import { operators } from '@openpanel/constants';
import type { IChartEventFilterOperator } from '@openpanel/validation';
import { mapKeys } from '@openpanel/validation';

interface FilterOperatorSelectProps {
  value: IChartEventFilterOperator;
  onChange: (operator: IChartEventFilterOperator) => void;
  children?: React.ReactNode;
}

export function FilterOperatorSelect({
  value,
  onChange,
  children,
}: FilterOperatorSelectProps) {
  const trigger = children ?? (
    <Button className="whitespace-nowrap" variant="outline">
      {operators[value]}
    </Button>
  );

  return (
    <DropdownMenuComposed
      contentProps={{
        collisionPadding: 8,
        side: 'bottom',
      }}
      items={mapKeys(operators).map((key) => ({
        value: key,
        label: operators[key],
      }))}
      label="Operator"
      onChange={onChange}
    >
      {trigger}
    </DropdownMenuComposed>
  );
}
