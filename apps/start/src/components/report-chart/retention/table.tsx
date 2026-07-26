import { max, min } from '@openpanel/common';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useEffect, useId, useState } from 'react';
import { useReportChartContext } from '../context';
import { useNumber } from '@/hooks/use-numer-formatter';
import { getPropertyLabel } from '@/translations/properties';
import type { RouterOutputs } from '@/trpc/client';
import { cn } from '@/utils/cn';
import { getChartColor } from '@/utils/theme';

export type CohortData = RouterOutputs['chart']['cohort']['data'];
type CohortRow = CohortData[number];

export interface CohortBreakdownGroup {
  key: string;
  label: string;
  summary: CohortRow;
  cohorts: CohortRow[];
}

export function getCohortBreakdownGroups(
  data: CohortData
): CohortBreakdownGroup[] {
  const groupedRows = new Map<string, CohortRow[]>();

  data.forEach((row) => {
    const key = JSON.stringify(row.breakdowns);
    const rows = groupedRows.get(key) ?? [];
    rows.push(row);
    groupedRows.set(key, rows);
  });

  return Array.from(groupedRows.entries()).map(([key, rows]) => {
    const summary =
      rows.find((row) => row.cohort_interval === 'Weighted Average') ??
      rows[0]!;

    return {
      key,
      label:
        summary?.breakdowns.map((value) => value || '(not set)').join(' / ') ||
        '(not set)',
      summary,
      cohorts: rows.filter((row) => row !== summary),
    };
  });
}

interface CohortTableProps {
  data: CohortData;
}

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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set()
  );
  const disclosureId = useId().replaceAll(':', '');
  const breakdownDefinitionKey = JSON.stringify(
    breakdowns.map((breakdown) => [breakdown.id, breakdown.name])
  );
  const hasBreakdowns = data.some((row) => row.breakdowns.length > 0);
  const breakdownGroups = hasBreakdowns ? getCohortBreakdownGroups(data) : [];
  const highestValue = max(data.map((row) => max(row.values)));
  const lowestValue = min(data.map((row) => min(row.values)));
  const rowWithHigestSum = data.find(
    (row) => row.sum === max(data.map((row) => row.sum))
  );

  useEffect(() => {
    setExpandedGroups(new Set());
  }, [data, breakdownDefinitionKey]);

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
    let percentage = 0.5;
    if (isPercentage) {
      percentage = value;
    } else if (range > 0) {
      percentage = (value - lowestValue) / range;
    }
    const opacity = Math.max(0.05, Number.isNaN(percentage) ? 0 : percentage);

    return {
      backgroundClassName: 'bg-highlight dark:bg-emerald-700',
      opacity,
    };
  };

  const thClassName =
    'h-10 align-top pt-3 whitespace-nowrap font-semibold text-muted-foreground';

  const toggleGroup = (key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const renderMetricCells = (row: CohortRow, keyPrefix: string) => {
    const values = isPercentage ? row.percentages : row.values;

    return (
      <>
        <td className="min-w-12 p-0">
          <div className="rounded px-3 font-medium font-mono">
            {number.format(row.sum)}
            {row === rowWithHigestSum && ' 🚀'}
          </div>
        </td>
        {values.map((value, index) => {
          const { opacity, backgroundClassName } = getBackground(value);
          const columnLabel = getColumnLabel(index);
          return (
            <td className="min-w-24 p-0" key={`${keyPrefix}:${columnLabel}`}>
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
                  style={{ opacity }}
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
      </>
    );
  };

  let firstColumnLabel = 'Date';
  if (hasBreakdowns) {
    firstColumnLabel =
      breakdowns.length > 0
        ? breakdowns
            .map((breakdown) => getPropertyLabel(breakdown.name))
            .join(' / ')
        : 'Breakdown';
  }

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
                    <div className="center-center -mt-3 h-10 px-4">
                      {firstColumnLabel}
                    </div>
                  </div>
                </th>
                <th className={cn(thClassName, 'pr-1')}>Total profiles</th>
                {data[0]?.values.map((_column, index) => (
                  <th
                    className={cn(thClassName, 'capitalize')}
                    key={index.toString()}
                  >
                    {getColumnLabel(index)}
                  </th>
                ))}
              </tr>
            </thead>
            {hasBreakdowns ? (
              breakdownGroups.map((group, groupIndex) => {
                const isExpanded = expandedGroups.has(group.key);
                const cohortRowsId = `${disclosureId}-cohorts-${groupIndex}`;
                return (
                  <Fragment key={group.key}>
                    <tbody>
                      <tr className="border-t bg-def-50">
                        <td className="sticky left-0 z-10 min-w-52 bg-def-50 p-0">
                          <button
                            aria-controls={cohortRowsId}
                            aria-expanded={isExpanded}
                            className="flex h-10 w-full items-center gap-2 px-4 text-left font-semibold hover:bg-def-200"
                            onClick={() => toggleGroup(group.key)}
                            type="button"
                          >
                            <span
                              aria-hidden
                              className="size-3 shrink-0 rounded-sm"
                              data-breakdown-color
                              style={{
                                backgroundColor: getChartColor(groupIndex),
                              }}
                            />
                            {isExpanded ? (
                              <ChevronDown className="size-4 shrink-0" />
                            ) : (
                              <ChevronRight className="size-4 shrink-0" />
                            )}
                            <span className="truncate" title={group.label}>
                              {group.label}
                            </span>
                          </button>
                        </td>
                        {renderMetricCells(group.summary, group.key)}
                      </tr>
                    </tbody>
                    <tbody hidden={!isExpanded} id={cohortRowsId}>
                      {group.cohorts.map((row) => (
                        <tr key={`${group.key}:${row.cohort_interval}`}>
                          <td className="sticky left-0 z-10 min-w-52 bg-card p-0">
                            <div className="flex h-10 items-center pr-4 pl-12 font-medium text-muted-foreground">
                              {row.cohort_interval}
                            </div>
                          </td>
                          {renderMetricCells(
                            row,
                            `${group.key}:${row.cohort_interval}`
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </Fragment>
                );
              })
            ) : (
              <tbody>
                {data.map((row) => (
                  <tr key={row.cohort_interval}>
                    <td className="sticky left-0 z-10 w-36 bg-card p-0">
                      <div className="center-center h-10 px-4 font-medium text-muted-foreground">
                        {row.cohort_interval}
                      </div>
                    </td>
                    {renderMetricCells(row, row.cohort_interval)}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      </div>
    </div>
  );
};

export default CohortTable;
