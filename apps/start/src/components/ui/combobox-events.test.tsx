/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComboboxEvents } from './combobox-events';
import { TooltipProvider } from './tooltip';

vi.mock('@/components/custom-events/create-custom-event-dialog', () => ({
  CreateCustomEventDialog: () => null,
}));

const LONG_EVENT_NAME = 'Application Installed From Attribution Campaign';

afterEach(cleanup);

describe('ComboboxEvents', () => {
  it('shows the complete selected event name above the truncated trigger on hover', async () => {
    render(
      <TooltipProvider>
        <div style={{ width: 180 }}>
          <ComboboxEvents
            items={
              [
                {
                  name: LONG_EVENT_NAME,
                  count: 1,
                  meta: null,
                  screenshots: [],
                },
              ] as any
            }
            onChange={() => undefined}
            placeholder="Select event"
            value={LONG_EVENT_NAME}
          />
        </div>
      </TooltipProvider>
    );

    const trigger = screen.getByRole('combobox', { name: LONG_EVENT_NAME });
    const label = screen.getByText(LONG_EVENT_NAME);

    expect(label.className).toContain('text-ellipsis');
    fireEvent.pointerMove(label);

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toBe(LONG_EVENT_NAME);
    expect(document.querySelector('[data-side="top"]')?.textContent).toContain(
      LONG_EVENT_NAME
    );
    expect(trigger.getAttribute('aria-label')).toBe(LONG_EVENT_NAME);
  });
});
