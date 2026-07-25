const REGAIN_SCREENSHOT_ORIGINS = new Set([
  'https://api.regainapp.ai',
  'https://staging.regainapp.ai',
]);

function hasAllowedScreenshotPath(url: URL) {
  return url.pathname.startsWith('/event_screenshots/');
}

export function getAllowedEventScreenshotUrl(value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !REGAIN_SCREENSHOT_ORIGINS.has(url.origin) ||
      !hasAllowedScreenshotPath(url)
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
