import { useSyncExternalStore } from 'react';

// The cache badge needs to render in the card / detail HEADER, which sits
// outside the chart's React context (the data hook lives deep inside
// <ReportChart>). So the hook publishes status into this module-level store
// keyed by report id, and the header subscribes by the same id.
export type ReportCacheEntry = {
  cachedAt: number | null;
  isRevalidating: boolean;
  canRefresh: boolean;
  refresh: () => void;
};

const store = new Map<string, ReportCacheEntry>();
const listeners = new Map<string, Set<() => void>>();

function emit(id: string) {
  const set = listeners.get(id);
  if (set) {
    for (const cb of set) {
      cb();
    }
  }
}

export function setReportCacheEntry(id: string, entry: ReportCacheEntry) {
  store.set(id, entry);
  emit(id);
}

export function clearReportCacheEntry(id: string) {
  if (store.delete(id)) {
    emit(id);
  }
}

export function useReportCacheEntry(
  id: string | undefined
): ReportCacheEntry | undefined {
  return useSyncExternalStore(
    (cb) => {
      if (!id) {
        return () => {};
      }
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(cb);
      return () => {
        set?.delete(cb);
      };
    },
    () => (id ? store.get(id) : undefined),
    () => undefined
  );
}
