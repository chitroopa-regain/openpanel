import { round } from '@openpanel/common';
import { Tooltiper } from '@/components/ui/tooltip';
import { useNumber } from '@/hooks/use-numer-formatter';
import { cn } from '@/utils/cn';
import { useReportChartContext } from '../context';
import {
  compactMetricCardClassName,
  compactMetricGridClassName,
  compactMetricLabelClassName,
  compactMetricValueClassName,
} from '../metric/metric-card-layout';
import { formatMetricDisplayValue } from '../metric/metric-value-format';
import {
  aggregateRetentionMetric,
  describeRetentionStep,
  type RetentionMetricAggregate,
  type RetentionMetricMeasure,
} from './retention-metric';
import { type CohortRow, getCohortBreakdownGroups } from './table';

interface Props {
  data: CohortRow[];
}

const MEASURE_LABEL: Record<RetentionMetricMeasure, string> = {
  retention_rate: 'Retention',
  unique_users: 'Unique users',
  property_sum: 'Sum',
  property_average: 'Average',
};

/**
 * Retention as one headline number per breakdown — every cohort in the date
 * range collapsed at the chosen step. This is what the Regain Pro board's
 * "Google Ads Revenue from New Users" style cards are: Mixpanel retention with
 * `disableCohortize` shown as an insights metric.
 */
export function RetentionMetric({ data }: Props) {
  const {
    report: { options: reportOptions, unit },
    options: { retentionLayout },
    isEditMode,
  } = useReportChartContext();
  const retentionOptions =
    reportOptions?.type === 'retention' ? reportOptions : undefined;
  const measure: RetentionMetricMeasure =
    retentionOptions?.metric ?? (unit === '%' ? 'retention_rate' : 'unique_users');
  const step = retentionOptions?.metricStep ?? 0;
  const retentionUnit = retentionOptions?.retentionUnit ?? 'day';
  const criteria = retentionOptions?.criteria ?? 'on_or_after';
  const property = retentionOptions?.property;

  const hasBreakdowns = data.some(
    (row) => row.breakdowns.length > 0 || Boolean(row.cohortKey),
  );
  const groups = hasBreakdowns
    ? getCohortBreakdownGroups(data).map((group) => ({
        key: group.key,
        label: group.label,
        aggregate: aggregateRetentionMetric(group.cohorts, step, measure),
      }))
    : [
        {
          key: 'all',
          label: undefined,
          aggregate: aggregateRetentionMetric(data, step, measure),
        },
      ];

  const stepLabel = describeRetentionStep(step, retentionUnit, criteria);
  const measureLabel =
    measure === 'property_sum' || measure === 'property_average'
      ? `${MEASURE_LABEL[measure]} of ${property?.replace(/^properties\./, '') ?? '…'}`
      : MEASURE_LABEL[measure];
  const isHero = groups.length === 1 && retentionLayout === 'dashboard';

  return (
    <div
      className={cn(
        isHero
          ? 'flex h-full w-full items-stretch'
          : compactMetricGridClassName,
        isEditMode && 'card p-4',
      )}
    >
      {groups.map((group) => (
        <RetentionMetricCard
          aggregate={group.aggregate}
          hero={isHero}
          key={group.key}
          label={group.label ?? measureLabel}
          measure={measure}
          stepLabel={group.label ? `${measureLabel} · ${stepLabel}` : stepLabel}
          unit={unit}
        />
      ))}
    </div>
  );
}

function RetentionMetricCard({
  aggregate,
  hero,
  label,
  measure,
  stepLabel,
  unit,
}: {
  aggregate: RetentionMetricAggregate;
  hero: boolean;
  label: string;
  measure: RetentionMetricMeasure;
  stepLabel: string;
  unit?: string;
}) {
  const number = useNumber();
  const { value } = aggregate;
  const isRate = measure === 'retention_rate';
  const valueUnit = isRate ? undefined : unit === '%' ? undefined : unit;

  const display =
    value === null
      ? 'N/A'
      : isRate
        ? `${round(value * 100, 2)}%`
        : formatMetricDisplayValue(round(value, 2));
  const exact =
    value === null
      ? 'No cohort has matured at this step yet'
      : isRate
        ? `${number.format(round(value * 100, 4))}%`
        : number.formatWithUnit(round(value, 2), valueUnit);

  const profilesText =
    aggregate.measuredProfiles === aggregate.totalProfiles
      ? `${number.format(aggregate.totalProfiles)} profiles · ${aggregate.totalCohorts} cohorts`
      : `${number.format(aggregate.measuredProfiles)} of ${number.format(aggregate.totalProfiles)} profiles matured · ${aggregate.measuredCohorts}/${aggregate.totalCohorts} cohorts`;

  const tooltip = (
    <div className="flex flex-col gap-1">
      <span className="font-medium">{label}</span>
      <span className="font-mono font-semibold">{exact}</span>
      <span className="text-muted-foreground">{stepLabel}</span>
      <span className="text-muted-foreground">{profilesText}</span>
    </div>
  );

  if (hero) {
    return (
      <div className="@container flex h-full w-full flex-1 flex-col items-center justify-center gap-3 px-6 py-6 text-center">
        <div className="max-w-full truncate text-sm font-medium text-muted-foreground">
          {label} · {stepLabel}
        </div>
        <Tooltiper content={tooltip}>
          <div
            className={cn(
              'max-w-full cursor-default truncate font-mono font-bold tracking-tight',
              'text-[clamp(2rem,9cqw,4.5rem)] leading-none',
              value === null && 'text-muted-foreground',
            )}
          >
            {display}
            {value !== null && valueUnit && (
              <span className="ml-2 text-[0.45em] font-light">{valueUnit}</span>
            )}
          </div>
        </Tooltiper>
        <div className="max-w-full truncate text-xs text-muted-foreground">
          {profilesText}
        </div>
      </div>
    );
  }

  return (
    <div className={compactMetricCardClassName}>
      <div className="flex h-full flex-col justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <div className={compactMetricLabelClassName} title={label}>
            {label}
          </div>
          <div className="truncate text-[11px] text-muted-foreground/80">
            {stepLabel}
          </div>
        </div>
        <Tooltiper content={tooltip}>
          <div
            className={cn(
              compactMetricValueClassName,
              value === null && 'text-muted-foreground',
            )}
          >
            {display}
            {value !== null && valueUnit && (
              <span className="ml-1 text-[0.45em] font-light">{valueUnit}</span>
            )}
          </div>
        </Tooltiper>
        <div className="truncate text-[11px] text-muted-foreground">
          {profilesText}
        </div>
      </div>
    </div>
  );
}
