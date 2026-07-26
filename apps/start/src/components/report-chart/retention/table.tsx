import { max, min } from '@openpanel/common';
import { useReportChartContext } from '../context';
import { useNumber } from '@/hooks/use-numer-formatter';
import type { RouterOutputs } from '@/trpc/client';
import { cn } from '@/utils/cn';
import { getPropertyLabel } from '@/translations/properties';

type CohortData = RouterOutputs['chart']['cohort']['data'];

type CohortTableProps = {
  data: CohortData;
};

const CohortTable: React.FC<CohortTableProps> = ({ data }) => {
  const {
    report: { unit, options, breakdowns },
  } = useReportChartContext();
  const retentionUnit =
    options?.type === 'retention' ? (options.retentionUnit ?? 'day') : 'day';
  const isPropertyMeasure =
    options?.type === 'retention' &&
    (options.metric === 'property_average' ||
      options.metric === 'property_sum');
  const isPercentage = !isPropertyMeasure && unit === '%';
  const number = useNumber();
  const highestValue = max(data.map((row) => max(row.values)));
  const lowestValue = min(data.map((row) => min(row.values)));
  const rowWithHigestSum = data.find(
    (row) => row.sum === max(data.map((row) => row.sum))
  );

  const getColumnLabel = (index: number) => {
    const unitLabel =
      retentionUnit.charAt(0).toUpperCase() + retentionUnit.slice(1);
    return index === 0 ? `< 1 ${unitLabel}` : `${unitLabel} ${index}`;
  };

  const getBackground = (value: number | undefined) => {
    if (!value) {
      return {
        backgroundClassName: '',
        opacity: 0,
      };
    }

    const range = highestValue - lowestValue;
    const percentage = isPercentage
      ? value
      : range > 0
        ? (value - lowestValue) / range
        : 0.5;
    const opacity = Math.max(0.05, isNaN(percentage) ? 0 : percentage);

    return {
      backgroundClassName: 'bg-highlight dark:bg-emerald-700',
      opacity,
    };
  };

  const thClassName =
    'h-10 align-top pt-3 whitespace-nowrap font-semibold text-muted-foreground';

  return (
    <div className="card relative overflow-hidden">
      <div
        className={'absolute top-px right-0 left-0 h-10 border-b bg-def-100'}
      />
      <div className="hide-scrollbar w-full overflow-x-auto">
        <div className="relative min-w-full">
          <table className="w-full table-auto whitespace-nowrap">
            <thead>
              <tr>
                <th className={cn(thClassName, 'sticky left-0 z-10')}>
                  <div className="bg-def-100">
                    <div className="center-center -mt-3 h-10">Date</div>
                  </div>
                </th>
                {breakdowns.map((breakdown) => (
                  <th
                    className={cn(thClassName, 'px-3 text-left')}
                    key={breakdown.id}
                  >
                    {getPropertyLabel(breakdown.name)}
                  </th>
                ))}
                <th className={cn(thClassName, 'pr-1')}>Total profiles</th>
                {data[0]?.values.map((column, index) => (
                  <th
                    className={cn(thClassName, 'capitalize')}
                    key={index.toString()}
                  >
                    {getColumnLabel(index)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row) => {
                const values = isPercentage ? row.percentages : row.values;
                return (
                  <tr
                    key={`${JSON.stringify(row.breakdowns)}:${row.cohort_interval}`}
                  >
                    <td className="sticky left-0 z-10 w-36 bg-card p-0">
                      <div className="center-center h-10 px-4 font-medium text-muted-foreground">
                        {row.cohort_interval}
                      </div>
                    </td>
                    {breakdowns.map((breakdown, index) => (
                      <td
                        className="min-w-28 px-3 font-medium"
                        key={breakdown.id}
                      >
                        {row.breakdowns?.[index] ?? '(not set)'}
                      </td>
                    ))}
                    <td className="min-w-12 p-0">
                      <div className={cn('rounded px-3 font-medium font-mono')}>
                        {number.format(row?.sum)}
                        {row.cohort_interval ===
                          rowWithHigestSum?.cohort_interval && ' 🚀'}
                      </div>
                    </td>
                    {values.map((value, index) => {
                      const { opacity, backgroundClassName } =
                        getBackground(value);
                      return (
                        <td
                          className="min-w-24 p-0"
                          key={row.cohort_interval + index.toString()}
                        >
                          <div
                            className={cn(
                              'center-center relative h-10 font-mono hover:shadow-[inset_0_0_0_2px_rgb(255,255,255)]',
                              opacity > 0.7 &&
                                'text-white [text-shadow:_0_0_3px_rgb(0_0_0_/_20%)]'
                            )}
                          >
                            <div
                              className={cn(
                                backgroundClassName,
                                'absolute inset-0 h-full w-full'
                              )}
                              style={{
                                opacity,
                              }}
                            />
                            <div className="relative">
                              {number.formatWithUnit(
                                value,
                                isPropertyMeasure ? undefined : unit
                              )}
                              {value === highestValue && ' 🚀'}
                            </div>
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default CohortTable;
