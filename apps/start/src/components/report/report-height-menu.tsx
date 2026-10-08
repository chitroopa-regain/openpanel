import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  getDefaultReportHeight,
  getReportHeight,
  REPORT_HEIGHTS,
} from './report-height';

export function ReportHeightMenu({
  report,
  disabled,
  onChange,
}: {
  report: Parameters<typeof getReportHeight>[0];
  disabled?: boolean;
  onChange: (height: number) => void;
}) {
  const defaultHeight = getDefaultReportHeight(report);
  return (
    <>
      <DropdownMenuLabel>Card height</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={String(getReportHeight(report))}
        onValueChange={(value) => onChange(Number(value))}
      >
        {REPORT_HEIGHTS.filter((height) => height >= defaultHeight).map(
          (height) => (
            <DropdownMenuRadioItem
              key={height}
              value={String(height)}
              disabled={disabled}
            >
              {height === defaultHeight
                ? 'Default height'
                : height === 6
                  ? 'Tall'
                  : height === 9
                    ? 'Extra tall'
                    : 'Maximum height'}
            </DropdownMenuRadioItem>
          )
        )}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
    </>
  );
}
