import { describe, expect, it } from 'vitest';
import { encodeEventCursor, zEventCursor } from './event-cursor';

describe('event cursor wire contract', () => {
  const event = {
    createdAt: new Date('2026-09-23T12:30:33.724Z'),
    id: 'b8435a9e-2bfa-4941-843f-75078ac57401',
  };
  it('round trips both ordering keys with millisecond precision', () => {
    expect(zEventCursor.parse(encodeEventCursor(event))).toEqual(event);
    expect(typeof encodeEventCursor(event)).toBe('string');
  });
  it('accepts legacy ISO cursors and optional first page', () => {
    expect(zEventCursor.parse(event.createdAt.toISOString())).toEqual(
      event.createdAt
    );
    expect(zEventCursor.optional().parse(undefined)).toBeUndefined();
  });
  it.each([
    '',
    'bad',
    '{}',
    '{',
    `v2|${event.createdAt.toISOString()}|${event.id}`,
    `v1|${event.createdAt.toISOString()}|' OR 1=1 --`,
    `v1|invalid|${event.id}`,
    `v1|${event.createdAt.toISOString()}|${event.id}|extra`,
    'v1|',
  ])('rejects malformed cursor %s', (value) => {
    expect(zEventCursor.safeParse(value).success).toBe(false);
  });
});
