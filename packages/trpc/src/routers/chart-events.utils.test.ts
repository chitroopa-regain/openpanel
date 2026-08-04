import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type EventScreenshot,
  fetchEventScreenshots,
  getAllowedEventScreenshotUrl,
  getMissingScreenshotContextEventNames,
  indexEventScreenshots,
  selectEventScreenshotSamples,
} from './chart-events.utils';

const validVariant = {
  screenshot_url:
    'https://api.regainapp.ai/event_screenshots/capture-1/image?token=secret',
  capture_id: 'capture-1',
  captured_at_ms: '1784822400123',
  app_package: 'ai.regain.app',
  app_version: '2.4.0',
  properties: { source: 'home', attempt: 2 },
  user_properties: { plan: 'pro' },
};

const sample = (overrides: Partial<EventScreenshot> = {}): EventScreenshot => ({
  url: validVariant.screenshot_url,
  captureId: 'capture-1',
  capturedAtMs: 1_784_822_400_123,
  appPackage: 'ai.regain.app',
  appVersion: '2.4.0',
  eventProperties: { source: 'home', attempt: 2 },
  userProperties: { plan: 'pro' },
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('event screenshot metadata', () => {
  it('retains requested context names missing from the event-name union', () => {
    const contexts = [
      { eventName: 'MV Lagging Event', filters: [] },
      { eventName: 'Dropped Event', filters: [] },
      { eventName: 'MV Lagging Event', filters: [] },
    ];

    expect(getMissingScreenshotContextEventNames(contexts, [])).toEqual([
      'MV Lagging Event',
      'Dropped Event',
    ]);
    expect(
      getMissingScreenshotContextEventNames(contexts, ['MV Lagging Event'])
    ).toEqual(['Dropped Event']);
    expect(
      getMissingScreenshotContextEventNames(contexts, ['Dropped Event'])
    ).toEqual(['MV Lagging Event']);
    expect(
      getMissingScreenshotContextEventNames(contexts, [
        'MV Lagging Event',
        'Dropped Event',
      ])
    ).toEqual([]);
  });

  it('does not synthesize a metadata-only dropped context when represented', () => {
    expect(
      getMissingScreenshotContextEventNames(
        [{ eventName: 'Dropped Without MV Row', filters: [] }],
        ['Dropped Without MV Row']
      )
    ).toEqual([]);
  });

  it('normalizes the protected Regain response and sorts newest first', () => {
    const screenshots = indexEventScreenshots({
      events: [
        {
          event_name: 'Paywall: Shown',
          variants: [
            { ...validVariant, capture_id: 'older', captured_at_ms: 100 },
            validVariant,
            { ...validVariant },
            {
              ...validVariant,
              capture_id: 'unsafe',
              screenshot_url: 'https://evil.example/capture.webp',
            },
          ],
        },
      ],
    });

    expect(screenshots.get('Paywall: Shown')).toEqual([
      sample(),
      expect.objectContaining({ captureId: 'older', capturedAtMs: 100 }),
    ]);
  });

  it('keeps representative samples version-diverse without a context', () => {
    const samples = [
      ...Array.from({ length: 6 }, (_, index) =>
        sample({
          captureId: `new-${index}`,
          capturedAtMs: 1_000 - index,
          appVersion: '61.2.1753',
        })
      ),
      sample({
        captureId: 'previous-release',
        capturedAtMs: 10,
        appVersion: '60.1.1741',
      }),
    ];

    const selected = selectEventScreenshotSamples(samples);
    expect(
      selected.filter((item) => item.appVersion === '61.2.1753')
    ).toHaveLength(3);
    expect(selected.map((item) => item.captureId)).toContain(
      'previous-release'
    );
    expect(selected[0]?.captureId).toBe('new-0');
  });

  it('matches event and user properties exactly and never falls back to a mismatch', () => {
    const samples = [
      sample({ captureId: 'latest-mismatch', capturedAtMs: 300 }),
      sample({
        captureId: 'exact',
        capturedAtMs: 200,
        eventProperties: { source: 'settings', attempt: 2 },
        userProperties: { plan: 'pro' },
      }),
    ];

    expect(
      selectEventScreenshotSamples(samples, {
        filters: [
          {
            property: 'properties.source',
            scope: 'event',
            values: ['settings'],
          },
          {
            property: 'profile.properties.plan',
            scope: 'user',
            values: ['pro'],
          },
        ],
      }).map((item) => item.captureId)
    ).toEqual(['exact']);
    expect(
      selectEventScreenshotSamples(samples, {
        filters: [
          { property: 'properties.attempt', scope: 'event', values: ['2'] },
        ],
      })
    ).toEqual([]);
  });

  it('matches breakdown values and inclusive capture dates', () => {
    expect(
      selectEventScreenshotSamples(
        [sample({ captureId: 'in-range', capturedAtMs: 200 })],
        {
          filters: [],
          breakdown: {
            property: 'properties.source',
            scope: 'event',
            values: ['home'],
          },
          startDateMs: 200,
          endDateMs: 200,
        }
      ).map((item) => item.captureId)
    ).toEqual(['in-range']);
    expect(
      selectEventScreenshotSamples([sample({ capturedAtMs: 199 })], {
        filters: [],
        startDateMs: 200,
      })
    ).toEqual([]);
  });

  it('makes one authenticated lookup for the ClickHouse event names', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            events: [
              { event_name: 'Paywall: Shown', variants: [validVariant] },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const screenshots = await fetchEventScreenshots(
      ['Paywall: Shown', 'Paywall: Shown'],
      [],
      {
        metadataUrl: 'https://metadata.internal/',
        readToken: 'read-token',
        fetchImpl,
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://metadata.internal/event_screenshots/internal/lookup',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Event-Screenshot-Token': 'read-token',
        },
        body: '{"event_names":["Paywall: Shown"],"variants_per_event":12}',
      })
    );
    expect(screenshots.get('Paywall: Shown')).toHaveLength(1);
  });

  it('sends exact property and date context before screenshot ranking', async () => {
    let requestBody: unknown;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        Response.json({
          events: [{ event_name: 'Paywall: Shown', variants: [validVariant] }],
        })
      );
    });
    await fetchEventScreenshots(
      ['Paywall: Shown'],
      [
        {
          eventName: 'Paywall: Shown',
          filters: [
            { property: 'properties.variant', scope: 'event', values: ['B'] },
            {
              property: 'profile.properties.plan',
              scope: 'user',
              values: ['pro'],
            },
          ],
          startDateMs: Date.UTC(2026, 5, 1),
          endDateMs: Date.UTC(2026, 5, 30),
        },
      ],
      {
        metadataUrl: 'https://metadata.internal',
        readToken: 'read-token',
        fetchImpl,
      }
    );

    expect(requestBody).toEqual({
      event_names: ['Paywall: Shown'],
      report_start_date: '2026-06-01',
      report_end_date: '2026-06-30',
      event_property_filters: { variant: 'B' },
      user_property_filters: { plan: 'pro' },
    });
  });

  it('chunks plain event lookups at the backend contract limit', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ events: [] }))
    );
    await fetchEventScreenshots(
      Array.from({ length: 201 }, (_, index) => `Event ${index}`),
      [],
      {
        metadataUrl: 'https://metadata.internal',
        readToken: 'read-token',
        fetchImpl,
      }
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('merges exact samples for multi-value is filters', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const variant = body.event_property_filters.variant;
      return Promise.resolve(
        Response.json({
          events: [
            {
              event_name: 'Paywall: Shown',
              variants: [
                {
                  ...validVariant,
                  capture_id: `capture-${variant}`,
                  captured_at_ms: variant === 'B' ? 200 : 100,
                  event_properties: { variant },
                },
              ],
            },
          ],
        })
      );
    });

    const screenshots = await fetchEventScreenshots(
      ['Paywall: Shown'],
      [
        {
          eventName: 'Paywall: Shown',
          filters: [
            {
              property: 'properties.variant',
              scope: 'event',
              values: ['A', 'B'],
            },
          ],
        },
      ],
      {
        metadataUrl: 'https://metadata.internal',
        readToken: 'read-token',
        fetchImpl,
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(
      screenshots.get('Paywall: Shown')?.map((item) => item.captureId)
    ).toEqual(['capture-B', 'capture-A']);
  });

  it('keeps successful lookup chunks when another chunk fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(
        Response.json({
          events: [
            {
              event_name: 'Event 100',
              variants: [validVariant],
            },
          ],
        })
      );

    const screenshots = await fetchEventScreenshots(
      Array.from({ length: 101 }, (_, index) => `Event ${index}`),
      [],
      {
        metadataUrl: 'https://metadata.internal',
        readToken: 'read-token',
        fetchImpl,
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(screenshots.get('Event 100')).toHaveLength(1);
  });

  it('does not fall back to an unfiltered screenshot for an unmatchable context', async () => {
    const fetchImpl = vi.fn();
    const screenshots = await fetchEventScreenshots(
      ['Paywall: Shown'],
      [
        {
          eventName: 'Paywall: Shown',
          filters: [],
          matchable: false,
        },
      ],
      {
        metadataUrl: 'https://metadata.internal',
        readToken: 'read-token',
        fetchImpl,
      }
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screenshots).toEqual(new Map());
  });

  it.each([
    500, 401,
  ])('fails soft on an upstream %s response', async (status) => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status }));
    await expect(
      fetchEventScreenshots(['Event'], [], {
        metadataUrl: 'https://metadata.internal',
        readToken: 'read-token',
        fetchImpl,
      })
    ).resolves.toEqual(new Map());
  });

  it('is disabled without both server settings and fails soft on invalid JSON', async () => {
    const fetchImpl = vi.fn();
    expect(
      await fetchEventScreenshots(['Event'], [], {
        metadataUrl: 'https://metadata.internal',
        readToken: '',
        fetchImpl,
      })
    ).toEqual(new Map());
    expect(fetchImpl).not.toHaveBeenCalled();

    const badFetch = vi.fn(async () => new Response('not json'));
    await expect(
      fetchEventScreenshots(['Event'], [], {
        metadataUrl: 'https://metadata.internal',
        readToken: 'read-token',
        fetchImpl: badFetch,
      })
    ).resolves.toEqual(new Map());
  });

  it.each([
    'javascript:alert(1)',
    'http://api.regainapp.ai/event_screenshots/capture/image',
    'https://evil.example/event_screenshots/capture/image',
    'https://api.regainapp.ai/users/avatar.webp',
  ])('rejects an unsafe capability URL: %s', (url) => {
    expect(getAllowedEventScreenshotUrl(url)).toBeNull();
  });
});
