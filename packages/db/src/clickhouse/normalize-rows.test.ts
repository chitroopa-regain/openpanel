import { describe, expect, it } from 'vitest';
import { normalizeChRows } from './client';

// The previous implementation, kept here as the reference behaviour.
function legacy<T extends Record<string, any>>(
  data: T[],
  meta?: Array<{ name: string; type: string }>
) {
  const keys = Object.keys(data[0] || {});
  return data.map((item) =>
    keys.reduce((acc, key) => {
      const m = meta?.find((x) => x.name === key);
      return {
        ...acc,
        [key]:
          item[key] && m?.type.includes('Int')
            ? Number.parseFloat(item[key] as string)
            : item[key],
      };
    }, {} as T)
  );
}

describe('normalizeChRows', () => {
  it('matches the previous reduce exactly, key order included', () => {
    const meta = [
      { name: 'day', type: 'String' },
      { name: 'n', type: 'UInt64' },
      { name: 'v', type: 'Float64' },
      { name: 'maybe', type: 'Nullable(Int64)' },
      { name: 'zero', type: 'Int32' },
      { name: 'arr', type: 'Array(String)' },
    ];
    const data = [
      { day: '2026-10-01', n: '123', v: 1.5, maybe: null, zero: '0', arr: ['a'] },
      { day: '2026-10-02', n: '9007199254740993', v: 0, maybe: '7', zero: 0, arr: [] },
      // A key missing from the first row is dropped, as before.
      { day: '2026-10-03', n: '', v: -2, maybe: '-1', zero: '5', arr: ['b'], extra: 1 },
    ] as Array<Record<string, any>>;
    const now = normalizeChRows(data, meta);
    expect(now).toEqual(legacy(data, meta));
    expect(now.map((r) => Object.keys(r))).toEqual(
      legacy(data, meta).map((r) => Object.keys(r))
    );
    expect(normalizeChRows([], meta)).toEqual([]);
    expect(normalizeChRows(data, undefined)).toEqual(legacy(data, undefined));
  });

  it('handles a wide result quickly', () => {
    const cols = 1300;
    const meta = Array.from({ length: cols }, (_, i) => ({ name: `c${i}`, type: i % 2 ? 'UInt64' : 'Float64' }));
    const row = Object.fromEntries(meta.map((m, i) => [m.name, i % 2 ? String(i) : i]));
    const data = Array.from({ length: 250 }, () => ({ ...row }));
    const t = Date.now();
    const out = normalizeChRows(data, meta);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(out[0]?.c1).toBe(1);
  });
});
