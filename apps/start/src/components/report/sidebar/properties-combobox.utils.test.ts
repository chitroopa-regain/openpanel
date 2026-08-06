import { describe, expect, it } from 'vitest';
import { resolvePropertiesQueryMode } from './properties-combobox.utils';

describe('resolvePropertiesQueryMode', () => {
  it('does not query metadata from the category index', () => {
    expect(resolvePropertiesQueryMode(undefined, 'index')).toBeUndefined();
  });

  it('uses the profile-only query after profile properties is selected', () => {
    expect(resolvePropertiesQueryMode(undefined, 'profile')).toBe('profile');
  });

  it('uses the event-only query after event properties is selected', () => {
    expect(resolvePropertiesQueryMode(undefined, 'event')).toBe('events');
  });

  it('keeps an explicitly configured picker mode', () => {
    expect(resolvePropertiesQueryMode('profile', 'index')).toBe('profile');
  });
});
