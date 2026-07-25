import { describe, expect, it } from 'vitest';
import { getAllowedEventScreenshotUrl } from './event-screenshot-url';

describe('getAllowedEventScreenshotUrl', () => {
  it.each([
    'https://api.regainapp.ai/event_screenshots/capture/image?token=secret',
    'https://staging.regainapp.ai/event_screenshots/capture/image?token=secret',
  ])('allows a trusted screenshot URL: %s', (url) => {
    expect(getAllowedEventScreenshotUrl(url)).toBe(url);
  });

  it.each([
    'javascript:alert(1)',
    'http://api.regainapp.ai/event_screenshots/capture/image?token=secret',
    'https://evil.example/event_screenshots/capture/image?token=secret',
    'https://api.regainapp.ai/users/avatar.webp',
    'https://screenshots.regainapp.ai/event-screenshots/capture.webp',
    'https://storage.googleapis.com/regain-event-screenshots/capture.webp',
    'https://firebasestorage.googleapis.com/v0/b/regain-event-screenshots/o/capture.webp',
  ])('rejects an unsafe screenshot URL: %s', (url) => {
    expect(getAllowedEventScreenshotUrl(url)).toBeNull();
  });
});
