import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const service = vi.hoisted(() => ({
  listManagedEvents: vi.fn(),
  dropManagedEvent: vi.fn(),
  undropManagedEvent: vi.fn(),
  getReplayRequest: vi.fn(),
  listEventDropAudit: vi.fn(),
}));

vi.mock('@openpanel/db', async () => {
  const rules = await import('../../../../packages/db/src/services/event-drop-rules');
  return {
    ...service,
    EventDropError: rules.EventDropError,
    MANAGED_EVENT_FILTERS: ['all', 'unused', 'used', 'dropped', 'protected', 'unused_high'],
  };
});
vi.mock('@/utils/rate-limiter', () => ({ activateRateLimiter: vi.fn() }));

import { EventDropError } from '../../../../packages/db/src/services/event-drop-rules';
import { isValidAdminToken } from '../utils/admin-token';
import eventDropRouter from './event-drop.router';

const TOKEN = 'test-admin-token-123';
const app = Fastify();

beforeAll(async () => {
  process.env.OPENPANEL_ADMIN_API_TOKEN = TOKEN;
  await app.register(eventDropRouter, { prefix: '/manage', rateLimit: false });
  await app.register(eventDropRouter, { prefix: '/api/manage', rateLimit: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENPANEL_ADMIN_API_TOKEN = TOKEN;
});

const auth = { authorization: `Bearer ${TOKEN}` };

describe('isValidAdminToken', () => {
  it('accepts only the exact bearer token', () => {
    expect(isValidAdminToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isValidAdminToken(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isValidAdminToken(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isValidAdminToken(TOKEN, TOKEN)).toBe(false);
    expect(isValidAdminToken('Bearer ', TOKEN)).toBe(false);
    expect(isValidAdminToken(undefined, TOKEN)).toBe(false);
    expect(isValidAdminToken(['a', 'b'], TOKEN)).toBe(false);
  });

  it('refuses everything when no token is configured', () => {
    expect(isValidAdminToken('Bearer anything', undefined)).toBe(false);
    expect(isValidAdminToken('Bearer ', '')).toBe(false);
  });
});

describe('/manage event drop API auth', () => {
  const routes = [
    { method: 'GET' as const, url: '/manage/projects/p1/events' },
    { method: 'POST' as const, url: '/manage/projects/p1/events/drop' },
    { method: 'POST' as const, url: '/manage/projects/p1/events/undrop' },
    { method: 'GET' as const, url: '/manage/projects/p1/audit' },
    { method: 'GET' as const, url: '/manage/replays/00000000-0000-0000-0000-000000000000' },
  ];

  it.each(routes)('$method $url is 401 without a token', async ({ method, url }) => {
    const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
    expect(res.statusCode).toBe(401);
  });

  it.each(routes)('$method $url is 401 with a wrong token', async ({ method, url }) => {
    const res = await app.inject({
      method,
      url,
      headers: { authorization: 'Bearer wrong' },
      payload: method === 'POST' ? {} : undefined,
    });
    expect(res.statusCode).toBe(401);
  });

  it('is 401 for everyone when OPENPANEL_ADMIN_API_TOKEN is unset', async () => {
    delete process.env.OPENPANEL_ADMIN_API_TOKEN;
    const res = await app.inject({ method: 'GET', url: '/manage/projects/p1/events', headers: auth });
    expect(res.statusCode).toBe(401);
    expect(service.listManagedEvents).not.toHaveBeenCalled();
  });

  it('never reaches the service without auth', async () => {
    await app.inject({
      method: 'POST',
      url: '/manage/projects/p1/events/drop',
      payload: { name: 'A', confirmName: 'A', source: 'UI' },
    });
    expect(service.dropManagedEvent).not.toHaveBeenCalled();
  });
});

describe('/manage event drop API with a token', () => {
  it('lists events with filter and search', async () => {
    service.listManagedEvents.mockResolvedValue({ events: [{ name: 'A' }] });
    const res = await app.inject({
      method: 'GET',
      url: '/manage/projects/p1/events?filter=unused&q=app',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ name: 'A' }]);
    expect(service.listManagedEvents).toHaveBeenCalledWith({ projectId: 'p1', filter: 'unused', q: 'app' });
  });

  it('400s an unknown filter', async () => {
    const res = await app.inject({ method: 'GET', url: '/manage/projects/p1/events?filter=bogus', headers: auth });
    expect(res.statusCode).toBe(400);
  });

  it('passes the drop body through and maps guard errors to their status', async () => {
    service.dropManagedEvent.mockRejectedValueOnce(new EventDropError('REASON_REQUIRED', 'used'));
    const body = {
      name: 'Home Page: Shown',
      confirmName: 'Home Page: Shown',
      source: 'Agent',
      requestedBy: 'Chitroopa',
      chatUrl: 'https://maker.example.com/maker/abc',
    };
    const conflict = await app.inject({ method: 'POST', url: '/manage/projects/p1/events/drop', headers: auth, payload: body });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'REASON_REQUIRED' });
    expect(service.dropManagedEvent).toHaveBeenCalledWith({ ...body, projectId: 'p1' });

    service.dropManagedEvent.mockRejectedValueOnce(new EventDropError('PROTECTED', 'no'));
    const forbidden = await app.inject({ method: 'POST', url: '/manage/projects/p1/events/drop', headers: auth, payload: body });
    expect(forbidden.statusCode).toBe(403);

    service.dropManagedEvent.mockRejectedValueOnce(new EventDropError('CONFIRM_MISMATCH', 'typo'));
    const bad = await app.inject({ method: 'POST', url: '/manage/projects/p1/events/drop', headers: auth, payload: body });
    expect(bad.statusCode).toBe(400);
  });

  it('400s a drop without a valid source', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/manage/projects/p1/events/drop',
      headers: auth,
      payload: { name: 'A', confirmName: 'A', source: 'Robot' },
    });
    expect(res.statusCode).toBe(400);
    expect(service.dropManagedEvent).not.toHaveBeenCalled();
  });

  it('undrops with replay and returns the replay id', async () => {
    service.undropManagedEvent.mockResolvedValue({ replayRequestId: 'r-1' });
    const res = await app.inject({
      method: 'POST',
      url: '/manage/projects/p1/events/undrop',
      headers: auth,
      payload: { name: 'A', confirmName: 'A', replay: true, source: 'UI' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ replayRequestId: 'r-1' });
  });

  it('returns replay status and 404s unknown ids', async () => {
    service.getReplayRequest.mockResolvedValueOnce({ status: 'done', copied: 1300000, error: null, projectId: 'p1', eventName: 'A', fromTs: 'x', toTs: 'y' });
    const ok = await app.inject({ method: 'GET', url: '/manage/replays/r-1', headers: auth });
    expect(ok.json()).toMatchObject({ status: 'done', copied: 1300000, error: null });

    service.getReplayRequest.mockRejectedValueOnce(new EventDropError('NOT_FOUND', 'Replay request not found'));
    const missing = await app.inject({ method: 'GET', url: '/manage/replays/nope', headers: auth });
    expect(missing.statusCode).toBe(404);
  });

  it('lists the audit log with a limit', async () => {
    service.listEventDropAudit.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/manage/projects/p1/audit?limit=5', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(service.listEventDropAudit).toHaveBeenCalledWith('p1', 5);
  });
});

describe('/api/manage (the path production nginx forwards to the api)', () => {
  it('serves the same routes with the same auth', async () => {
    service.listManagedEvents.mockResolvedValue({ events: [] });
    const unauthorized = await app.inject({ method: 'GET', url: '/api/manage/projects/p1/events' });
    expect(unauthorized.statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/api/manage/projects/p1/events', headers: auth });
    expect(ok.statusCode).toBe(200);
  });

  it('returns 409 with a clear message while a replay is running', async () => {
    service.dropManagedEvent.mockRejectedValueOnce(
      new EventDropError('REPLAY_IN_PROGRESS', 'Replay of this event is still running; try again when it finishes')
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/manage/projects/p1/events/drop',
      headers: auth,
      payload: { name: 'A', confirmName: 'A', source: 'UI' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'REPLAY_IN_PROGRESS',
      message: 'Replay of this event is still running; try again when it finishes',
    });
  });
});
