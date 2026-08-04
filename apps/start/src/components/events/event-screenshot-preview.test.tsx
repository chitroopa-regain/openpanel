/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventScreenshotPreview } from './event-screenshot-preview';

const APP_METADATA = /ai\.regain\.app · 2\.4\.0/;
const PREVIEW_SCREENSHOTS = /Preview screenshots/;
const APP_VERSION_250 = /2\.5\.0/;

const screenshot = {
  url: 'https://api.regainapp.ai/event_screenshots/capture-1/image?token=secret',
  captureId: 'capture-1',
  capturedAtMs: 1_784_822_400_123,
  appPackage: 'ai.regain.app',
  appVersion: '2.4.0',
  eventProperties: { source: 'home', attempt: 2 },
  userProperties: { plan: 'pro' },
};

afterEach(cleanup);

describe('EventScreenshotPreview', () => {
  it('stops row selection and opens an accessible preview with both property scopes', () => {
    const onParentClick = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions lint/a11y/useKeyWithClickEvents: simulates the selectable event row that contains this button
      <div onClick={onParentClick}>
        <EventScreenshotPreview
          eventName="Paywall: Shown"
          screenshots={[screenshot]}
        />
      </div>
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Preview screenshots for Paywall: Shown',
      })
    );

    expect(onParentClick).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Paywall: Shown screenshots' })
    ).toBeTruthy();
    expect(screen.getByText(APP_METADATA)).toBeTruthy();
    expect(screen.getByText('Event properties')).toBeTruthy();
    expect(screen.getByText('User properties')).toBeTruthy();
    expect(screen.getByText('source')).toBeTruthy();
    expect(screen.getByText('home')).toBeTruthy();
    expect(screen.getByText('plan')).toBeTruthy();
    expect(screen.getByText('pro')).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    const image = screen.getByRole('img', {
      name: 'Paywall: Shown event screenshot',
    });
    expect(image.getAttribute('src')).toBe(screenshot.url);
    expect(image.className).toContain('object-contain');
    expect(dialog.className).toContain('overflow-hidden');
    expect(dialog.className).toContain('bg-def-100');
    expect(image.parentElement?.parentElement?.className).toContain(
      'grid-rows-[minmax(0,1fr)_auto]'
    );
    expect(
      document.body.querySelector('[data-slot="dialog-overlay"]')
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows one latest-image trigger and navigates all returned samples in the gallery', () => {
    const second = {
      ...screenshot,
      captureId: 'capture-2',
      url: 'https://api.regainapp.ai/event_screenshots/capture-2/image?token=secret',
      appVersion: '2.5.0',
    };
    render(
      <EventScreenshotPreview
        eventName="Paywall: Shown"
        screenshots={[screenshot, second]}
      />
    );

    expect(
      screen.getAllByRole('button', { name: PREVIEW_SCREENSHOTS })
    ).toHaveLength(1);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Preview screenshots for Paywall: Shown',
      })
    );
    expect(
      screen.getByRole('group', { name: 'Screenshot gallery' })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next screenshot' }));
    expect(
      screen
        .getByRole('img', { name: 'Paywall: Shown event screenshot' })
        .getAttribute('src')
    ).toBe(second.url);
    expect(screen.getByText(/ai\.regain\.app · 2\.5\.0/)).toBeTruthy();
  });

  it('filters the gallery by app version and restores all versions', () => {
    const second = {
      ...screenshot,
      captureId: 'capture-2',
      url: 'https://api.regainapp.ai/event_screenshots/capture-2/image?token=secret',
      appVersion: '2.5.0',
    };
    render(
      <EventScreenshotPreview
        eventName="Paywall: Shown"
        screenshots={[screenshot, second]}
      />
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Preview screenshots for Paywall: Shown',
      })
    );
    expect(
      screen.getByRole('group', { name: 'Filter screenshots by app version' })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '2.4.0' }));
    expect(
      screen
        .getByRole('img', { name: 'Paywall: Shown event screenshot' })
        .getAttribute('src')
    ).toBe(screenshot.url);
    expect(
      screen.queryByRole('group', { name: 'Screenshot gallery' })
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All versions' }));
    expect(
      screen.getByRole('group', { name: 'Screenshot gallery' })
    ).toBeTruthy();
  });

  it('renders nothing for disallowed URLs', () => {
    const { container } = render(
      <EventScreenshotPreview
        eventName="Paywall: Shown"
        screenshots={[
          {
            ...screenshot,
            url: 'https://evil.example/event-screenshots/a.webp',
          },
        ]}
      />
    );

    expect(container.querySelector('button')).toBeNull();
  });

  it('shows an explicit state when an exact contextual sample is unavailable', () => {
    render(
      <EventScreenshotPreview
        eventName="Paywall: Shown"
        screenshots={[]}
        showNoMatch
      />
    );
    expect(
      screen.getByRole('status', {
        name: 'No matching screenshot sampled yet',
      })
    ).toBeTruthy();
  });

  it('replaces an unavailable signed image with a non-broken status', () => {
    const onImageError = vi.fn();
    const { container, rerender } = render(
      <EventScreenshotPreview
        eventName="Paywall: Shown"
        onImageError={onImageError}
        screenshots={[screenshot]}
        showNoMatch
      />
    );

    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    fireEvent.error(image as HTMLImageElement);
    fireEvent.error(image as HTMLImageElement);

    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-label')).toBe(
      'No matching screenshot sampled yet'
    );
    expect(onImageError).toHaveBeenCalledTimes(1);

    const refreshed = {
      ...screenshot,
      url: `${screenshot.url}-refreshed`,
    };
    rerender(
      <EventScreenshotPreview
        eventName="Paywall: Shown"
        onImageError={onImageError}
        screenshots={[refreshed]}
        showNoMatch
      />
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      refreshed.url
    );
  });
});
