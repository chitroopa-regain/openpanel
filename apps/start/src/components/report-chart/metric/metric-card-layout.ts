export const compactMetricGridClassName =
  'grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(9rem,100%),1fr))] gap-4';

export const compactMetricCardClassName =
  'group @container relative h-full min-h-[140px] min-w-0 overflow-hidden rounded-xl border border-border/80 px-4 pb-4 pt-5 hover:z-10 @max-[160px]:px-3 @max-[160px]:pt-4';

export const compactMetricLabelClassName =
  'min-w-0 max-w-full truncate text-left text-[clamp(0.75rem,10cqw,1rem)] leading-tight text-muted-foreground';

export const compactMetricValueClassName =
  'max-w-full cursor-default truncate font-mono text-[clamp(1.5rem,24cqw,4rem)] font-bold leading-none tracking-tight';
