export const funnelMetricGridClassName =
  'grid w-full min-w-0 grid-cols-[repeat(auto-fit,minmax(min(5.25rem,100%),1fr))] gap-3';

export const funnelMetricCardClassName =
  'card group @container relative flex min-h-[88px] min-w-0 cursor-default flex-col items-start justify-center gap-2 overflow-hidden p-3';

export const funnelMetricLabelClassName =
  'flex min-w-0 max-w-full items-center gap-2 truncate text-muted-foreground text-[clamp(0.62rem,8cqw,0.875rem)] leading-tight';

export const funnelMetricValueClassName =
  'max-w-full truncate font-mono text-[clamp(1.2rem,19cqw,2rem)] font-bold leading-none tracking-tight';

export function getFunnelMetricValueFontSizePx(
  containerWidth: number,
  valueLength: number,
) {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return undefined;
  }

  const length = Math.max(valueLength, 1);
  const maxPx = 32;
  const minPx = 18;
  const horizontalPaddingPx = 24;
  const monoCharacterWidthEm = 0.62;
  const availableWidth = Math.max(containerWidth - horizontalPaddingPx, minPx);
  const fittedPx = availableWidth / (length * monoCharacterWidthEm);

  return Math.max(minPx, Math.min(maxPx, Math.floor(fittedPx)));
}
