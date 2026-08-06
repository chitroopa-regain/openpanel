import { describe, expect, it } from 'vitest';
import { getChartPropertiesQueryScopes } from './chart-properties.utils';

describe('getChartPropertiesQueryScopes', () => {
  it('only queries profile metadata for the profile picker', () => {
    expect(getChartPropertiesQueryScopes('profile')).toEqual({
      eventProperties: false,
      profileProperties: true,
    });
  });

  it('only queries event metadata for the event picker', () => {
    expect(getChartPropertiesQueryScopes('events')).toEqual({
      eventProperties: true,
      profileProperties: false,
    });
  });

  it('preserves the combined legacy response when no mode is provided', () => {
    expect(getChartPropertiesQueryScopes()).toEqual({
      eventProperties: true,
      profileProperties: true,
    });
  });
});
