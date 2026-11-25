import type { RouterOutputs } from '@/trpc/client';

export type ManagedEventsData = RouterOutputs['event']['managedEvents'];
export type ManagedEvent = ManagedEventsData['events'][number];
export type UsedInItem = ManagedEvent['usedIn'][number];
export type AuditRow = RouterOutputs['event']['eventDropAudit'][number];

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** 16154952 → 16M, 7057200 → 7.1M, 186000 → 186K */
export function shortCount(n: number | null | undefined): string {
  if (n === null || n === undefined) {
    return '—';
  }
  if (n >= 1e9) {
    return `${(n / 1e9).toFixed(1)}B`;
  }
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  }
  return String(Math.round(n));
}

export function formatPct(pct: number | null): string {
  if (pct === null) {
    return '—';
  }
  if (pct > 0 && pct < 0.01) {
    return '<0.01%';
  }
  return `${pct.toFixed(2)}%`;
}

/** 23 Nov */
const PLAIN_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function shortDate(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  // A plain day (the IST volume day) is a calendar date: never shift it
  // through the browser's timezone.
  const plain = PLAIN_DAY.exec(iso);
  if (plain) {
    return `${Number(plain[3])} ${MONTHS[Number(plain[2]) - 1]}`;
  }
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "09:10 IST": the volume rollup's clock. */
export function istTime(iso: string): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
  return `${time} IST`;
}

/** 23 Nov, 12:15 */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) {
    return '—';
  }
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) {
    return '—';
  }
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) {
    return '<1 min ago';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours} h ago`;
  }
  return `${Math.floor(hours / 24)} d ago`;
}

export function places(n: number): string {
  return `${n} ${n === 1 ? 'place' : 'places'}`;
}

/** Boards (with their reports) from an event's usedIn list. */
export function groupUsedIn(usedIn: UsedInItem[]) {
  const groups: { board: UsedInItem; reports: UsedInItem[] }[] = [];
  for (const item of usedIn) {
    if (item.type === 'board') {
      groups.push({ board: item, reports: [] });
    } else {
      groups.at(-1)?.reports.push(item);
    }
  }
  return groups;
}

export const ACTION_LABEL: Record<AuditRow['action'], string> = {
  drop: 'Drop',
  drop_anyway: 'Drop anyway',
  undrop: 'Undrop',
  keep: 'Keep',
  unkeep: 'Remove Keep',
};

/** "23 Nov, 14:37" in the given timezone (the project's). */
export function dateTimeInZone(
  iso: string | null | undefined,
  timeZone: string
): string {
  if (!iso) {
    return '—';
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('day')} ${get('month')}, ${get('hour')}:${get('minute')}`;
}
