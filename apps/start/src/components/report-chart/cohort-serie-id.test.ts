import { describe, expect, it } from 'vitest';
import { parseCohortSerieId } from './cohort-serie-id';

describe('parseCohortSerieId', () => {
  it('reads both polarities of a bucket', () => {
    // The KEY NAMES are the contract: call sites spread this into a drill-down
    // payload, so a mismatch here silently drops the polarity and the server
    // falls back to `in` — a `Not In` drill-down would list members.
    expect(parseCohortSerieId('abc-123:in')).toEqual({
      cohortId: 'abc-123',
      cohortMembership: 'in',
    });
    expect(parseCohortSerieId('abc-123:not_in')).toEqual({
      cohortId: 'abc-123',
      cohortMembership: 'not_in',
    });
  });

  it('returns null for an ordinary series id, so nothing is invented', () => {
    // A property-breakdown or plain series must NOT be read as a cohort bucket:
    // that would apply a restriction the chart never applied.
    expect(parseCohortSerieId('none')).toBeNull();
    expect(parseCohortSerieId('IN / android')).toBeNull();
    expect(parseCohortSerieId(undefined)).toBeNull();
    expect(parseCohortSerieId('')).toBeNull();
  });

  it('rejects an unknown suffix rather than guessing', () => {
    expect(parseCohortSerieId('abc:maybe')).toBeNull();
  });

  it('splits from the right so a colon inside the id survives', () => {
    expect(parseCohortSerieId('a:b:not_in')).toEqual({
      cohortId: 'a:b',
      cohortMembership: 'not_in',
    });
  });
});
