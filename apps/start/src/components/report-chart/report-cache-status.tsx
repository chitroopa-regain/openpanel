import { formatDistanceToNowStrict } from 'date-fns';
import { RefreshCwIcon } from 'lucide-react';
import { useReportCacheEntry } from './report-cache-store';
import { cn } from '@/utils/cn';

// Mixpanel-style transient refresh indicator, rendered in the report header.
// While a stale cached result is being revalidated in the background, it shows
// the age of the data on screen + a spinning arrow. Once the fresh result has
// been swapped in (revalidation done), it renders nothing.
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

  // cachedAt is the server's clock; clamp so a lagging client clock can't
  // render a future "in X seconds".
  const updatedAt = Math.min(entry.cachedAt, Date.now());

  const age = formatDistanceToNowStrict(updatedAt, { addSuffix: true });

  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1 text-muted-foreground text-xs',
        className
      )}
      title={`Updating chart. Last updated ${age}.`}
    >
      <span>Updating</span>
      <RefreshCwIcon className="size-3.5 animate-spin" />
    </div>
  );
}
