import { describe, expect, it } from 'vitest';
import { resolvePropertyValuesEventName } from './overview-filters';

describe('resolvePropertyValuesEventName', () => {
  it('scopes property values to the single selected event', () => {
    expect(resolvePropertyValuesEventName(['Razorpay Checkout Launched'])).toBe(
      'Razorpay Checkout Launched'
    );
  });

  it('falls back to all events when none or multiple events are selected', () => {
    expect(resolvePropertyValuesEventName([])).toBe('*');
    expect(resolvePropertyValuesEventName(['Event A', 'Event B'])).toBe('*');
  });
});
