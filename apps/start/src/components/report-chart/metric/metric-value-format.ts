const COMPACT_THRESHOLD = 9999;
const THOUSAND = 1000;
const MILLION = 1_000_000;

function trimTrailingDecimal(value: string) {
  return value.replace(/\.0$/, '');
}

function formatCompactThousands(value: number) {
  const sign = value < 0 ? '-' : '';
  const truncated = Math.trunc((Math.abs(value) / THOUSAND) * 10) / 10;

  return `${sign}${trimTrailingDecimal(truncated.toFixed(1))}K`;
}

export function formatMetricDisplayValue(value: number) {
  const absValue = Math.abs(value);

  if (absValue > COMPACT_THRESHOLD && absValue < MILLION) {
    return formatCompactThousands(value);
  }

  if (absValue >= MILLION) {
    return new Intl.NumberFormat('en-US', {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value);
  }

  return new Intl.NumberFormat('en-US').format(value);
}
