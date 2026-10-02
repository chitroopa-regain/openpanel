import { max, min } from '@openpanel/common';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useEffect, useId, useState } from 'react';
import { useReportChartContext } from '../context';
import {
  ReportSeriesScreenshot,
  ReportSeriesScreenshotsProvider,
} from '../common/report-series-screenshots';
import {
  type AcquisitionColumn,
  availableAcquisitionColumns,
  formatRoas,
  resolveAcquisitionColumns,
} from './acquisition-columns';
import { Checkbox } from '@/components/ui/checkbox';
import { useNumber } from '@/hooks/use-numer-formatter';
import { getPropertyLabel } from '@/translations/properties';
import type { RouterOutputs } from '@/trpc/client';
import { cn } from '@/utils/cn';
import { getChartColor } from '@/utils/theme';

export type CohortData = RouterOutputs['chart']['cohort']['data'];
/**
 * A row, optionally stamped with the custom-cohort bucket it came from.
 *
 * Identity is `cohortKey` = `${cohortId}:${membership}`, assigned where the
 * buckets are flattened — NOT the label. Two custom cohorts can share a name,
 * and `In 'X'` / `Not In 'X'` must never collapse into one another; keying on
 * what is displayed would do exactly that.
 */
export type CohortRow = CohortData[number] & {
  cohortKey?: string;
  cohortLabel?: string;
  /** Ad spend (INR) matched to this cohort; present with acquisition cost on. */
  spend?: number | null;
  /** spend / cohort size. `null` = unpaid source or an empty cohort. */
  cpi?: number | null;
  /** revenue / spend per window; `null` = unpaid, unspent or incomplete. */
  roas?: {
    d0: number | null;
    d7: number | null;
    d30: number | null;
    lifetime: number | null;
  } | null;
};

export type AcquisitionCost = NonNullable<
  RouterOutputs['chart']['cohort']['acquisitionCost']
>;

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const inrCpi = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

export function describeAcquisitionCost(cost: AcquisitionCost) {
  const base = describeAcquisitionSpend(cost);
  return cost.roasAvailable
    ? `${base} · ROAS = cohort revenue / spend; D-n shown once day n has fully passed`
    : `${base} · ROAS needs a revenue metric (Property Sum or Property Average)`;
}

const PLATFORM_LABEL: Record<string, string> = {
  google_ads: 'Google',
  meta_ads: 'Meta',
  apple_ads: 'Apple',
};

function describeCoverage(cost: AcquisitionCost) {
  const entries = Object.entries(cost.coverageFrom ?? {});
  if (entries.length === 0) {
    return '';
  }
  return ` · ${entries
    .map(
      ([platform, from]) =>
        `${PLATFORM_LABEL[platform] ?? platform} rows before ${from} read — (installs not attributable then)`
    )
    .join(', ')}`;
}

function describeAcquisitionSpend(cost: AcquisitionCost) {
  const total = inr.format(cost.totalSpend);
  if (cost.mode === 'blended') {
    return `Spend, CPI & ROAS: blended paid ad spend (Google + Meta + Apple, only for the OS the cohort contains) over every install in the cohort · ${total} in range`;
  }
  const by = cost.breakdown
    ? getPropertyLabel(cost.breakdown)
    : cost.mode.replace('_', ' ');
  return `Spend, CPI & ROAS: matched by ${by} (${cost.mode === 'source' ? 'ad platform' : 'campaign'}) · ${inr.format(cost.attributedSpend)} of ${total} matched to the rows shown · organic rows have no CPI${describeCoverage(cost)}`;
}

export interface CohortBreakdownGroup {
  key: string;
  label: string;
  summary: CohortRow;
  cohorts: CohortRow[];
}

export function getCohortBreakdownGroups(
  data: CohortRow[]
): CohortBreakdownGroup[] {
  const groupedRows = new Map<string, CohortRow[]>();

  data.forEach((row) => {
    // A custom-cohort bucket groups by its own identity; everything else keeps
    // grouping by the property-breakdown values as before. The two never mix:
    // the server rejects a property breakdown beside a cohort breakdown.
    const key = row.cohortKey ?? JSON.stringify(row.breakdowns);
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
        summary?.cohortLabel ??
        (summary?.breakdowns.map((value) => value || '(not set)').join(' / ') ||
          '(not set)'),
      summary,
      cohorts: rows.filter((row) => row !== summary),
    };
  });
}

interface CohortTableProps {
  data: CohortRow[];
  /** Present when the report shows ad Spend / CPI columns. */
  acquisitionCost?: AcquisitionCost | null;
  /** Whole-population rows, present only with a breakdown. See index.tsx. */
  overall?: CohortRow[] | null;
}

/** Group key reserved for the pinned whole-population row. */
export const OVERALL_GROUP_KEY = '__overall__';

const CohortTable: React.FC<CohortTableProps> = ({
  data,
  overall,
  acquisitionCost,
}) => {
  const {
    report: { unit, options, breakdowns, series },
  } = useReportChartContext();
  const retentionUnit =
    options?.type === 'retention' ? (options.retentionUnit ?? 'day') : 'day';
  const isPropertyMeasure =
    options?.type === 'retention' &&
    (options.metric === 'property_average' ||
      options.metric === 'property_sum');
  const isPercentage = !isPropertyMeasure && unit === '%';
  const roasAvailable = Boolean(acquisitionCost?.roasAvailable);
  const savedColumns =
    options?.type === 'retention' ? options.acquisitionColumns : undefined;
  // Viewer-side tick boxes, seeded from the report's saved selection. They
  // only change what this screen shows; the report editor's sidebar saves.
  const [ticked, setTicked] = useState<Set<string>>(
    () =>
      new Set(
        resolveAcquisitionColumns(savedColumns, true).map((c) => c.key)
      )
  );
  const savedColumnsKey = JSON.stringify(savedColumns ?? null);
  useEffect(() => {
    setTicked(
      new Set(
        resolveAcquisitionColumns(
          JSON.parse(savedColumnsKey) ?? undefined,
          true
        ).map((c) => c.key)
      )
    );
  }, [savedColumnsKey]);
  const costColumns: AcquisitionColumn[] = acquisitionCost
    ? availableAcquisitionColumns(roasAvailable).filter((c) =>
        ticked.has(c.key)
      )
    : [];
  const toggleColumn = (key: string, on: boolean) =>
    setTicked((current) => {
      const next = new Set(current);
      if (on) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  const number = useNumber();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set()
  );
  const disclosureId = useId().replaceAll(':', '');
  const breakdownDefinitionKey = JSON.stringify(
    breakdowns.map((breakdown) => [breakdown.id, breakdown.name])
  );
  const hasBreakdowns = data.some(
    (row) => row.breakdowns.length > 0 || Boolean(row.cohortKey),
  );
  const breakdownGroups = hasBreakdowns ? getCohortBreakdownGroups(data) : [];
  // Pinned above the buckets, outside their sort/top-N and colour index. Its
  // own cohorts expand like any group; no screenshot (it has no breakdown
  // value to look one up by) and no rocket (it is not a competitor).
  const overallGroup: CohortBreakdownGroup | null =
    hasBreakdowns && overall && overall.length > 0
      ? (() => {
          const summary =
            overall.find((row) => row.cohort_interval === 'Weighted Average') ??
            overall[0]!;
          return {
            key: OVERALL_GROUP_KEY,
            label: 'Overall',
            summary,
            cohorts: overall.filter((row) => row !== summary),
          };
        })()
      : null;
  const screenshotSeries = breakdownGroups.flatMap((group) => {
    const event = series[0];
    if (!event || event.type !== 'event') return [];
    return [
      {
        id: group.key,
        serieType: 'event' as const,
        event: {
          id: event.id,
          name: event.name,
          breakdowns: Object.fromEntries(
            breakdowns.map((breakdown, index) => [
              breakdown.name,
              group.summary.breakdowns[index] ?? null,
            ])
          ),
        },
      },
    ];
  });
  const observedValues = data
    .flatMap((row) => row.values)
    .filter((value): value is number => value !== null);
  const highestValue = observedValues.length > 0 ? max(observedValues) : 0;
  const lowestValue = observedValues.length > 0 ? min(observedValues) : 0;
  // The 'Weighted Average' rows now carry the TOTAL cohort size, so comparing
  // them against individual cohort rows would hand the rocket to a summary row
  // unconditionally. Compare like with like: when broken down, the collapsed
  // summaries compete with each other; otherwise the real cohort rows do.
  const summaryRows = data.filter(
    (row) => row.cohort_interval === 'Weighted Average'
  );
  const cohortRows = data.filter(
    (row) => row.cohort_interval !== 'Weighted Average'
  );
  const rocketCandidates = hasBreakdowns ? summaryRows : cohortRows;
  const rowWithHigestSum =
    rocketCandidates.length > 0
      ? rocketCandidates.find(
          (row) => row.sum === max(rocketCandidates.map((r) => r.sum))
        )
      : undefined;

  useEffect(() => {
    setExpandedGroups(new Set());
  }, [data, breakdownDefinitionKey]);

  const getColumnLabel = (index: number) => {
    const unitLabel =
      retentionUnit.charAt(0).toUpperCase() + retentionUnit.slice(1);
    return index === 0 ? `< 1 ${unitLabel}` : `${unitLabel} ${index}`;
  };

  const getBackground = (value: number | null | undefined) => {
    if (value === null || value === undefined || value === 0) {
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

  const renderCostCell = (row: CohortRow, column: AcquisitionColumn) => {
    if (column.key === 'spend') {
      return (
        <div className="px-3 text-right font-mono text-muted-foreground">
          {row.spend === null || row.spend === undefined
            ? '—'
            : inr.format(row.spend)}
        </div>
      );
    }
    if (column.key === 'cpi') {
      return (
        <div className="px-3 text-right font-medium font-mono">
          {row.cpi === null || row.cpi === undefined
            ? '—'
            : inrCpi.format(row.cpi)}
        </div>
      );
    }
    const value = column.roas ? row.roas?.[column.roas] : null;
    return (
      <div
        className={cn(
          'px-3 text-right font-mono',
          value !== null && value !== undefined && value >= 1
            ? 'font-semibold text-emerald-600 dark:text-emerald-400'
            : 'font-medium'
        )}
      >
        {formatRoas(value)}
      </div>
    );
  };

  const renderMetricCells = (row: CohortRow, keyPrefix: string) => {
    const values = isPercentage ? row.percentages : row.values;

    return (
      <>
        {costColumns.map((column) => (
          <td
            className="min-w-20 p-0"
            data-testid={`retention-${column.key.replace('_', '-')}-cell`}
            key={`${keyPrefix}:${column.key}`}
          >
            {renderCostCell(row, column)}
          </td>
        ))}
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
                  {value === null
                    ? '—'
                    : number.formatWithUnit(
                        value,
                        isPropertyMeasure ? undefined : unit
                      )}
                  {value !== null && value === highestValue && ' 🚀'}
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
    <ReportSeriesScreenshotsProvider chartSeries={screenshotSeries as never}>
    {acquisitionCost && (
      <div
        className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"
        data-testid="retention-acquisition-columns"
      >
        {availableAcquisitionColumns(roasAvailable).map((column) => {
          const id = `${disclosureId}-col-${column.key}`;
          const short =
            column.minDay !== undefined &&
            column.minDay > (acquisitionCost.roasMaxDay ?? 0);
          return (
            <label
              className="flex cursor-pointer items-center gap-2"
              htmlFor={id}
              key={column.key}
              title={column.title}
            >
              <Checkbox
                checked={ticked.has(column.key)}
                id={id}
                onCheckedChange={(on) => toggleColumn(column.key, on === true)}
              />
              <span className={cn(short && 'text-muted-foreground')}>
                {column.label}
                {short && ' (range too short)'}
              </span>
            </label>
          );
        })}
      </div>
    )}
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
                {costColumns.map((column) => (
                  <th
                    className={cn(thClassName, 'px-3 text-right')}
                    key={column.key}
                    title={column.title}
                  >
                    {column.label}
                  </th>
                ))}
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
              [
                ...(overallGroup ? [overallGroup] : []),
                ...breakdownGroups,
              ].map((group, index) => {
                const isOverall = group.key === OVERALL_GROUP_KEY;
                // Colour index stays positional in breakdownGroups so pinning
                // the Overall row does not shift every bucket's colour.
                const groupIndex = overallGroup ? index - 1 : index;
                const isExpanded = expandedGroups.has(group.key);
                const cohortRowsId = `${disclosureId}-cohorts-${group.key.replace(/\W/g, '')}`;
                return (
                  <Fragment key={group.key}>
                    <tbody>
                      <tr
                        className={cn(
                          'border-t bg-def-50',
                          isOverall && 'border-b-2',
                        )}
                        data-testid={
                          isOverall ? 'retention-overall-row' : undefined
                        }
                      >
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
                              className={cn(
                                'size-3 shrink-0 rounded-sm',
                                isOverall && 'border-2 border-foreground/50',
                              )}
                              data-breakdown-color
                              style={
                                isOverall
                                  ? undefined
                                  : { backgroundColor: getChartColor(groupIndex) }
                              }
                            />
                            {isExpanded ? (
                              <ChevronDown className="size-4 shrink-0" />
                            ) : (
                              <ChevronRight className="size-4 shrink-0" />
                            )}
                            <span className="truncate" title={group.label}>
                              {group.label}
                            </span>
                            {!isOverall && series[0]?.type === 'event' && (
                              <ReportSeriesScreenshot
                                eventName={`${series[0].name} — ${group.label}`}
                                serieId={group.key}
                                showNoMatch={false}
                              />
                            )}
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
      {acquisitionCost && (
        <div
          className="border-t px-4 py-2 text-muted-foreground text-xs"
          data-testid="retention-acquisition-cost-note"
        >
          {describeAcquisitionCost(acquisitionCost)}
        </div>
      )}
    </div>
    </ReportSeriesScreenshotsProvider>
  );
};

export default CohortTable;
