export const funnelMetricGridClassName =
  'grid w-full min-w-0 grid-cols-[repeat(auto-fit,minmax(min(7rem,100%),1fr))] gap-4';

export const funnelMetricCardClassName =
  'card group @container relative flex min-h-[92px] min-w-0 cursor-default flex-col items-start justify-center gap-2 overflow-hidden p-3';

export const funnelMetricLabelClassName =
  'flex min-w-0 max-w-full items-center gap-2 truncate text-muted-foreground text-[clamp(0.68rem,9cqw,0.875rem)] leading-tight';

export const funnelMetricValueClassName =
  'max-w-full truncate font-mono text-[clamp(1.35rem,22cqw,2.25rem)] font-bold leading-none tracking-tight';

export function getFunnelMetricValueFontSizePx(
  containerWidth: number,
  valueLength: number,
) {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return undefined;
  }

  const length = Math.max(valueLength, 1);
  const maxPx = 36;
  const minPx = 20;
  const horizontalPaddingPx = 24;
  const monoCharacterWidthEm = 0.62;
  const availableWidth = Math.max(containerWidth - horizontalPaddingPx, minPx);
  const fittedPx = availableWidth / (length * monoCharacterWidthEm);

  return Math.max(minPx, Math.min(maxPx, Math.floor(fittedPx)));
}
