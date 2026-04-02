import { describe, expect, it } from 'vitest';
import { filterEventSearchItems } from './combobox-events-search';

const items = [
  { name: 'FT: Overlay Shown' },
  { name: 'FT: Overlay Back Pressed' },
  { name: 'FT: Overlay Permission Missing Opened' },
  { name: 'rc_all_purchases_converted' },
  { name: 'rc_all_purchases' },
];

describe('filterEventSearchItems', () => {
  it('matches colon-separated event names with spaced queries', () => {
    const results = filterEventSearchItems(items, 'FT Ove');

    expect(results.map((item) => item.name)).toEqual([
      'FT: Overlay Shown',
      'FT: Overlay Back Pressed',
      'FT: Overlay Permission Missing Opened',
    ]);
  });

  it('matches punctuation-heavy queries against normalized event names', () => {
    const results = filterEventSearchItems(items, 'FT: Ove');

    expect(results[0]?.name).toBe('FT: Overlay Shown');
  });

  it('matches underscore queries against underscore event names', () => {
    const results = filterEventSearchItems(items, 'rc_purc');

    expect(results.map((item) => item.name)).toEqual([
      'rc_all_purchases_converted',
      'rc_all_purchases',
    ]);
  });

  it('matches ordered token prefixes across separated words', () => {
    const results = filterEventSearchItems(items, 'rc purchas');

    expect(results.map((item) => item.name)).toEqual([
      'rc_all_purchases_converted',
      'rc_all_purchases',
    ]);
  });

  it('matches later tokens in order without requiring contiguous words', () => {
    const results = filterEventSearchItems(items, 'rc convert');

    expect(results.map((item) => item.name)).toEqual([
      'rc_all_purchases_converted',
    ]);
  });

  it('returns no matches when the query does not fit any event', () => {
    expect(filterEventSearchItems(items, 'totally missing')).toEqual([]);
  });
});
