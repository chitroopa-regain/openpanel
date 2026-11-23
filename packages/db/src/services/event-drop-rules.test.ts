import { describe, expect, it } from 'vitest';
import {
  assertCanDrop,
  assertCanUndrop,
  EventDropError,
  getReplayWindow,
  isProtectedEventName,
} from './event-drop-rules';

function dropError(fn: () => unknown): EventDropError {
  try {
    fn();
  } catch (error) {
    if (error instanceof EventDropError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected an EventDropError');
}

describe('isProtectedEventName', () => {
  it.each([
    'session_start',
    'session_end',
    'screen_view',
    'Server: Purchase',
    'Subscription: Paywall Viewed',
    'Subscription Intro BS: Shown',
    'OB 11: Permission Screen',
    'App: Crashed',
    'App Init: Revenue Cat Configured',
    'App Init: Install Referrer Captured',
    'Experiment Exposure',
    'Offer Spin: Shown',
    'Trial Started',
    'Checkout Opened',
    'meta_ad_click',
    'anr detected',
  ])('protects %s', (name) => {
    expect(isProtectedEventName(name)).toBe(true);
  });

  it.each([
    'Auth Interceptor: Request Failed',
    'Group Preview: Data Fetch Success',
    'App Init: Logback Only',
    'Home Page: Shown',
    'Stamp Book: Card Shown',
    // `anr` only as a whole word; `^OB` only at the start; `^meta` only at the start
    'Banner Shown',
    'Job Board Opened',
    'Home Meta Synced',
  ])('does not protect %s', (name) => {
    expect(isProtectedEventName(name)).toBe(false);
  });
});

describe('assertCanDrop', () => {
  const base = {
    name: 'App Init: Logback Only',
    confirmName: 'App Init: Logback Only',
    isDropped: false,
    usageCount: 0,
  };

  it('allows an unused event with the exact name typed', () => {
    expect(assertCanDrop(base)).toEqual({ action: 'drop', reason: null });
  });

  it('keeps an optional reason on a plain drop', () => {
    expect(assertCanDrop({ ...base, reason: '  Not used anywhere  ' })).toEqual({
      action: 'drop',
      reason: 'Not used anywhere',
    });
  });

  it('rejects a confirmation that differs (case, spaces) with 400', () => {
    for (const confirmName of ['app init: logback only', 'App Init: Logback Only ', '', 'App Init']) {
      const error = dropError(() => assertCanDrop({ ...base, confirmName }));
      expect(error.code).toBe('CONFIRM_MISMATCH');
      expect(error.httpStatus).toBe(400);
    }
  });

  it('checks the confirmation before anything else', () => {
    const error = dropError(() =>
      assertCanDrop({ ...base, name: 'Server: Purchase', confirmName: 'nope', usageCount: 705 })
    );
    expect(error.code).toBe('CONFIRM_MISMATCH');
  });

  it('refuses protected events with 403 even with a reason', () => {
    const error = dropError(() =>
      assertCanDrop({
        ...base,
        name: 'Subscription: Paywall Viewed',
        confirmName: 'Subscription: Paywall Viewed',
        reason: 'please',
      })
    );
    expect(error.code).toBe('PROTECTED');
    expect(error.httpStatus).toBe(403);
  });

  it('refuses built-in session events', () => {
    const error = dropError(() =>
      assertCanDrop({ ...base, name: 'session_start', confirmName: 'session_start' })
    );
    expect(error.code).toBe('PROTECTED');
  });

  it('needs a reason (409) when the event is used', () => {
    const used = { ...base, name: 'Home Page: Shown', confirmName: 'Home Page: Shown', usageCount: 7 };
    for (const reason of [undefined, null, '', '   ']) {
      const error = dropError(() => assertCanDrop({ ...used, reason }));
      expect(error.code).toBe('REASON_REQUIRED');
      expect(error.httpStatus).toBe(409);
      expect(error.message).toContain('7 places');
    }
    expect(
      assertCanDrop({ ...used, reason: 'Home shown is now tracked by Home: Opened' })
    ).toEqual({
      action: 'drop_anyway',
      reason: 'Home shown is now tracked by Home: Opened',
    });
  });

  it('refuses an event that is already dropped', () => {
    const error = dropError(() => assertCanDrop({ ...base, isDropped: true }));
    expect(error.code).toBe('ALREADY_DROPPED');
    expect(error.httpStatus).toBe(400);
  });

  it('refuses the "*" pseudo event', () => {
    expect(dropError(() => assertCanDrop({ ...base, name: '*', confirmName: '*' })).code).toBe(
      'INVALID_INPUT'
    );
  });
});

describe('assertCanUndrop', () => {
  it('needs the exact name and a dropped event', () => {
    expect(() =>
      assertCanUndrop({ name: 'A', confirmName: 'A', isDropped: true })
    ).not.toThrow();
    expect(
      dropError(() => assertCanUndrop({ name: 'A', confirmName: 'a', isDropped: true })).code
    ).toBe('CONFIRM_MISMATCH');
    expect(
      dropError(() => assertCanUndrop({ name: 'A', confirmName: 'A', isDropped: false })).code
    ).toBe('NOT_DROPPED');
  });

  it('allows undropping a protected event that was dropped before the rules existed', () => {
    expect(() =>
      assertCanUndrop({ name: 'Server: Purchase', confirmName: 'Server: Purchase', isDropped: true })
    ).not.toThrow();
  });
});

describe('getReplayWindow', () => {
  const now = new Date('2026-11-23T12:00:00Z');

  it('replays from the drop when it is within 24 h', () => {
    const droppedAt = new Date('2026-11-23T10:40:00Z');
    expect(getReplayWindow(droppedAt, now)).toEqual({ fromTs: droppedAt, toTs: now });
  });

  it('clamps to the last 24 h the holding topic keeps', () => {
    const droppedAt = new Date('2026-11-20T09:00:00Z');
    expect(getReplayWindow(droppedAt, now)).toEqual({
      fromTs: new Date('2026-11-22T12:00:00Z'),
      toTs: now,
    });
  });
});
