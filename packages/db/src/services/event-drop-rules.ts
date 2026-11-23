/**
 * Pure rules for dropping an event name. No IO here so the guard is unit
 * tested on its own and shared by the REST API and tRPC (one code path).
 */

/** OpenPanel's own events: sessions and screen views are built from them. */
export const BUILTIN_PROTECTED_EVENTS = [
  'session_start',
  'session_end',
  'screen_view',
] as const;

/**
 * Business-critical names that can never be dropped: purchases, revenue,
 * attribution, crashes, A/B exposure, paywall and onboarding. Same rule as the
 * unused-events analysis (regainapp 01ca425e49, analyze.py PROT).
 */
export const PROTECTED_EVENT_PATTERN =
  /exposure|exposed|experiment|^OB|onboarding|paywall|subscription|offer|purchase|revenue|refund|payment|paid|crash|anr\b|attribution|install|utm|referr|campaign|^meta|server:|checkout|trial/i;

/** Share of the project's daily volume above which an unused event is "high volume". */
export const HIGH_VOLUME_PCT = 0.5;

/** Dropped messages sit in destination-messages-short for this long. */
export const HOLD_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A board is active when it was viewed (or, before views were recorded, edited) this recently. */
export const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function isProtectedEventName(name: string): boolean {
  return (
    (BUILTIN_PROTECTED_EVENTS as readonly string[]).includes(name) ||
    PROTECTED_EVENT_PATTERN.test(name)
  );
}

export type EventDropSource = 'UI' | 'Agent';

export type EventDropErrorCode =
  | 'CONFIRM_MISMATCH'
  | 'PROTECTED'
  | 'REASON_REQUIRED'
  | 'ALREADY_DROPPED'
  | 'NOT_DROPPED'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'UNAVAILABLE';

const HTTP_STATUS: Record<EventDropErrorCode, number> = {
  CONFIRM_MISMATCH: 400,
  INVALID_INPUT: 400,
  ALREADY_DROPPED: 400,
  NOT_DROPPED: 400,
  PROTECTED: 403,
  NOT_FOUND: 404,
  REASON_REQUIRED: 409,
  UNAVAILABLE: 503,
};

export class EventDropError extends Error {
  readonly code: EventDropErrorCode;
  readonly httpStatus: number;

  constructor(code: EventDropErrorCode, message: string) {
    super(message);
    this.name = 'EventDropError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
  }
}

export type DropGuardInput = {
  name: string;
  confirmName: string;
  reason?: string | null;
  isDropped: boolean;
  /** Number of boards, reports, cohorts and custom events that use the event. */
  usageCount: number;
};

/**
 * Throws an EventDropError when the drop must not go ahead. Order matters:
 * a typo in the confirmation is reported before anything about the event.
 */
export function assertCanDrop(input: DropGuardInput): {
  action: 'drop' | 'drop_anyway';
  reason: string | null;
} {
  const name = input.name.trim();
  if (!name || name === '*') {
    throw new EventDropError('INVALID_INPUT', 'Event name is required');
  }
  if (input.confirmName !== input.name) {
    throw new EventDropError(
      'CONFIRM_MISMATCH',
      `Type the exact event name "${input.name}" to confirm`
    );
  }
  if (isProtectedEventName(input.name)) {
    throw new EventDropError(
      'PROTECTED',
      `"${input.name}" is protected (purchase, revenue, attribution, crash, A/B, paywall, onboarding or a built-in event) and cannot be dropped`
    );
  }
  if (input.isDropped) {
    throw new EventDropError(
      'ALREADY_DROPPED',
      `"${input.name}" is already dropped`
    );
  }
  const reason = input.reason?.trim() || null;
  if (input.usageCount > 0) {
    if (!reason) {
      throw new EventDropError(
        'REASON_REQUIRED',
        `"${input.name}" is used in ${input.usageCount} place${input.usageCount === 1 ? '' : 's'}; give a reason to drop it anyway`
      );
    }
    return { action: 'drop_anyway', reason };
  }
  return { action: 'drop', reason };
}

export function assertCanUndrop(input: {
  name: string;
  confirmName: string;
  isDropped: boolean;
}) {
  if (input.confirmName !== input.name) {
    throw new EventDropError(
      'CONFIRM_MISMATCH',
      `Type the exact event name "${input.name}" to confirm`
    );
  }
  if (!input.isDropped) {
    throw new EventDropError('NOT_DROPPED', `"${input.name}" is not dropped`);
  }
}

/**
 * The replay window: from the drop (or 24 h ago, when the drop is older; the
 * holding topic keeps 24 h) to the undrop.
 */
export function getReplayWindow(
  droppedAt: Date,
  now: Date
): { fromTs: Date; toTs: Date } {
  const oldestHeld = new Date(now.getTime() - HOLD_WINDOW_MS);
  return {
    fromTs: droppedAt > oldestHeld ? droppedAt : oldestHeld,
    toTs: now,
  };
}
