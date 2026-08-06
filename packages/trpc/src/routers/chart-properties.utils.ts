export type ChartPropertiesMode = 'events' | 'profile';

export function getChartPropertiesQueryScopes(mode?: ChartPropertiesMode) {
  return {
    eventProperties: mode !== 'profile',
    profileProperties: mode !== 'events',
  };
}
