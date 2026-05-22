import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useReportChartContext } from './context';
import {
  clearReportCacheEntry,
  setReportCacheEntry,
} from './report-cache-store';

// Runtime-only metadata the server attaches to cached report payloads.
type WithCacheMeta = {
  _cache?: { cachedAt: number; stale: boolean };
};

type RevalidationResult = { data: unknown };

type BypassOptions = { queryKey: QueryKey; queryFn?: unknown };

/**
 * Stale-while-revalidate glue for a report chart.
 *
 * The leaf still owns its own `useQuery(...)` (so types stay inferred). This
 * hook reads the server's `_cache` metadata off the result and:
 *   - publishes `cachedAt` / `isRevalidating` to the chart context so
 *     <ReportCacheStatus> can render "Updated X ago" + a spinner,
 *   - when the cached value is stale, fires a background request that bypasses
 *     the cache, then seeds the displayed query with the fresh result (no key
 *     swap, so the chart never flickers),
 *   - registers that same path as the manual refresh handler.
 *
 * @param result       the leaf's useQuery result (only `.data` is read)
 * @param queryKey     the displayed query's key (to seed with fresh data)
 * @param buildBypass  builds queryOptions with `bypassCache: true`
 */
export function useReportRevalidation(
  result: RevalidationResult,
  queryKey: QueryKey,
  buildBypass: () => BypassOptions
) {
  const queryClient = useQueryClient();
  const { report, reportId, shareId } = useReportChartContext();
  const id = reportId ?? report?.id;
  const [isRevalidating, setIsRevalidating] = useState(false);

  // The server ignores bypassCache for share views, so a forced recompute would
  // just return the same stale value and re-trigger this effect forever. Public
  // viewers therefore only ever read the shared cache; never revalidate.
  const canRevalidate = !shareId;

  const meta = (result.data as WithCacheMeta | undefined)?._cache;
  const cachedAt = meta?.cachedAt ?? null;
  const stale = meta?.stale ?? false;

  // Refs so the stable revalidate() always sees the latest key/builder.
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;
  const buildRef = useRef(buildBypass);
  buildRef.current = buildBypass;
  const inFlight = useRef(false);

  const revalidate = useCallback(() => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setIsRevalidating(true);
    queryClient
      // staleTime: 0 forces a recompute even on rapid manual refreshes.
      .fetchQuery({ ...buildRef.current(), staleTime: 0 } as never)
      .then((fresh) => {
        queryClient.setQueryData(keyRef.current, fresh);
      })
      .catch(() => {})
      .finally(() => {
        inFlight.current = false;
        setIsRevalidating(false);
      });
  }, [queryClient]);

  // Auto-revalidate once whenever the served value is stale.
  useEffect(() => {
    if (canRevalidate && stale && !inFlight.current) {
      revalidate();
    }
  }, [canRevalidate, stale, revalidate]);

  // Publish status into the store so the header badge (rendered outside this
  // chart's React context) can read it, keyed by report id. canRefresh is false
  // for share views, which hides the refresh button there.
  useEffect(() => {
    if (!id) {
      return;
    }
    setReportCacheEntry(id, {
      cachedAt,
      isRevalidating,
      canRefresh: canRevalidate,
      refresh: revalidate,
    });
  }, [id, cachedAt, isRevalidating, canRevalidate, revalidate]);

  // Drop the store entry when this chart unmounts.
  useEffect(() => {
    return () => {
      if (id) {
        clearReportCacheEntry(id);
      }
    };
  }, [id]);
}
