export type PropertiesComboboxMode = 'events' | 'profile';
export type PropertiesComboboxState = 'index' | 'event' | 'profile';

export function resolvePropertiesQueryMode(
  mode: PropertiesComboboxMode | undefined,
  state: PropertiesComboboxState
): PropertiesComboboxMode | undefined {
  if (mode) {
    return mode;
  }
  if (state === 'event') {
    return 'events';
  }
  if (state === 'profile') {
    return 'profile';
  }
  return undefined;
}
