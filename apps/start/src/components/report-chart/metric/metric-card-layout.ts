export const compactMetricGridClassName =
  'grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(8.5rem,100%),1fr))] gap-4';

export const compactMetricCardClassName =
  'group @container relative h-full min-h-[140px] min-w-0 overflow-hidden rounded-xl border border-border/80 px-3 pb-4 pt-5 hover:z-10';

export const compactMetricLabelClassName =
  'min-w-0 max-w-full truncate text-left text-[clamp(0.7rem,5.5cqw,0.875rem)] leading-tight text-muted-foreground';

export const compactMetricValueClassName =
  'max-w-full cursor-default truncate font-mono text-[clamp(1.25rem,13cqw,2.75rem)] font-bold leading-none tracking-tight';

export function getCompactMetricValueFontSizePx(
  containerWidth: number,
  valueLength: number,
) {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return undefined;
  }

  const length = Math.max(valueLength, 1);
  const maxPx = 44;
  const minPx = 20;
  const horizontalPaddingPx = 24;
  const monoCharacterWidthEm = 0.62;
  const availableWidth = Math.max(containerWidth - horizontalPaddingPx, minPx);
  const fittedPx = availableWidth / (length * monoCharacterWidthEm);

  return Math.max(minPx, Math.min(maxPx, Math.floor(fittedPx)));
}

export function getCompactMetricLabelFontSizePx(
  containerWidth: number,
  labelLength: number,
) {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return undefined;
  }

  const length = Math.max(labelLength, 1);
  const maxPx = 14;
  const minPx = 11;
  const horizontalPaddingPx = 24;
  const characterWidthEm = 0.58;
  const availableWidth = Math.max(containerWidth - horizontalPaddingPx, minPx);
  const fittedPx = availableWidth / (length * characterWidthEm);

  return Math.max(minPx, Math.min(maxPx, Math.floor(fittedPx)));
}
