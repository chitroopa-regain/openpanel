import { describe, expect, it } from 'vitest';
import { extractRetentionSelection } from './retention-series';

const f = (name: string, value: unknown[], operator = 'is') =>
  ({ name, operator, value }) as any;

describe('extractRetentionSelection', () => {
  it('finds the reserved filter wherever it sits, not at index 0', () => {
    // The whole point. Positional extraction read filters[0] and would have
    // returned ['IN'] as the event list here.
    const r = extractRetentionSelection({
      type: 'event',
      name: '*',
      filters: [f('country', ['IN']), f('name', ['FT: Session Completed'])],
    });
    expect(r.names).toEqual(['FT: Session Completed']);
    expect(r.otherFilters).toEqual([f('country', ['IN'])]);
  });

  it('🔴 the wrong-query fixture: an ordinary first filter is NOT the event list', () => {
    // This is the case that produced an ENABLED, silently wrong retention query:
    // firstEvent came back as ['IN'] and the country filter was dropped.
    const r = extractRetentionSelection({
      type: 'event',
      name: 'Application Installed',
      filters: [f('country', ['IN'])],
    });
    expect(r.names).toEqual([]);
    expect(r.names).not.toEqual(['IN']);
    // And the filter survives instead of being sliced away.
    expect(r.otherFilters).toEqual([f('country', ['IN'])]);
  });

  it('no reserved filter means UNSET, never match-all', () => {
    const r = extractRetentionSelection({ type: 'event', name: '*', filters: [] });
    expect(r.names).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('duplicate reserved filters are an explicit error, not a guess', () => {
    const r = extractRetentionSelection({
      type: 'event',
      name: '*',
      filters: [f('name', ['A']), f('name', ['B'])],
    });
    expect(r.error).toBeTruthy();
    // Never silently pick one (narrows) or union them (widens).
    expect(r.names).toEqual([]);
  });

  it('an empty reserved value is CONSUMED, not passed through as a filter', () => {
    // Leaving `name is []` live would match nothing and silently zero the chart.
    const r = extractRetentionSelection({
      type: 'event',
      name: '*',
      filters: [f('name', []), f('country', ['IN'])],
    });
    expect(r.names).toEqual([]);
    expect(r.otherFilters).toEqual([f('country', ['IN'])]);
  });

  it('a non-`is` name filter is an ordinary exclusion, not a selector', () => {
    const r = extractRetentionSelection({
      type: 'event',
      name: '*',
      filters: [f('name', ['Spam Event'], 'isNot')],
    });
    expect(r.names).toEqual([]);
    expect(r.otherFilters).toEqual([f('name', ['Spam Event'], 'isNot')]);
  });

  it('a custom event has no selector and keeps all its filters', () => {
    const r = extractRetentionSelection({
      type: 'custom_event',
      filters: [f('country', ['IN'])],
    } as any);
    expect(r.names).toEqual([]);
    expect(r.otherFilters).toEqual([f('country', ['IN'])]);
  });

  it('handles formulas, null and undefined without throwing', () => {
    expect(extractRetentionSelection({ type: 'formula' } as any).names).toEqual([]);
    expect(extractRetentionSelection(null).names).toEqual([]);
    expect(extractRetentionSelection(undefined).names).toEqual([]);
  });

  it('keeps multi-name selections intact', () => {
    const r = extractRetentionSelection({
      type: 'event',
      name: '*',
      filters: [f('name', ['A', 'B', 'C'])],
    });
    expect(r.names).toEqual(['A', 'B', 'C']);
  });
});
