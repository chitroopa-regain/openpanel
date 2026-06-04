import { RefreshCwIcon } from 'lucide-react';
import { useReportCacheEntry } from './report-cache-store';
import { cn } from '@/utils/cn';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatCacheAge(timestamp: number, now = Date.now()) {
  // cachedAt is the server's clock; clamp so a lagging client clock can't
  // render a future/negative age.
  const ageMs = Math.max(0, now - Math.min(timestamp, now));

  if (ageMs < MINUTE) {
    return 'now';
  }

  if (ageMs < HOUR) {
    return `${Math.floor(ageMs / MINUTE)}m ago`;
  }

  if (ageMs < DAY) {
    return `${Math.floor(ageMs / HOUR)}h ago`;
  }

  return `${Math.floor(ageMs / DAY)}d ago`;
}

// Mixpanel-style transient refresh indicator, rendered in the report header.
// While a stale cached result is being revalidated in the background, it shows
// a compact data age + a spinning arrow. Once the fresh result has been swapped
// in (revalidation done), it renders nothing.
export function ReportCacheBadge({
  reportId,
  className,
}: {
  reportId: string | undefined;
  className?: string;
}) {
  const entry = useReportCacheEntry(reportId);

  if (!(entry?.isRevalidating && entry.cachedAt)) {
    return null;
  }

  const age = formatCacheAge(entry.cachedAt);

  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1 text-muted-foreground text-xs',
        className
      )}
      title={`Updating chart. Cached ${age}.`}
    >
      <span>{age}</span>
      <RefreshCwIcon className="size-3.5 animate-spin" />
    </div>
  );
}
