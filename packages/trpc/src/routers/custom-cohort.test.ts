import { describe, expect, it } from 'vitest';
import { isResourceLimitError } from './custom-cohort';

describe('isResourceLimitError', () => {
  it('does NOT classify a syntax error as a resource limit', () => {
    // Regression: ClickHouse echoes the offending query in a syntax error, and
    // the preview query contains `max_execution_time` in its SETTINGS clause.
    // A text-matching classifier called this a timeout and the UI showed
    // "Too large to preview" for what was actually a broken query.
    const err = new Error(
      'Code: 62. DB::Exception: Syntax error: failed at position 1: SELECT uniqExact(profile_id) FROM (...) ' +
        'SETTINGS max_execution_time = 30, timeout_overflow_mode = \'throw\'. (SYNTAX_ERROR)',
    );
    expect(isResourceLimitError(err)).toBe(false);
  });

  it('classifies TIMEOUT_EXCEEDED (159)', () => {
    expect(
      isResourceLimitError(
        new Error('Code: 159. DB::Exception: Timeout exceeded: elapsed 30.1 seconds. (TIMEOUT_EXCEEDED)'),
      ),
    ).toBe(true);
  });

  it('classifies TOO_SLOW (160) and MEMORY_LIMIT_EXCEEDED (241)', () => {
    expect(isResourceLimitError(new Error('Code: 160. DB::Exception: Estimated query execution time is too long. (TOO_SLOW)'))).toBe(true);
    expect(isResourceLimitError(new Error('Code: 241. DB::Exception: Memory limit (total) exceeded. (MEMORY_LIMIT_EXCEEDED)'))).toBe(true);
  });

  it('prefers a structured code over the message', () => {
    const err = Object.assign(new Error('Code: 62. some syntax noise'), { code: 241 });
    expect(isResourceLimitError(err)).toBe(true);
  });

  it('treats a non-ClickHouse error as not a resource limit', () => {
    expect(isResourceLimitError(new Error('socket hang up'))).toBe(false);
    expect(isResourceLimitError('not an error')).toBe(false);
  });
});
