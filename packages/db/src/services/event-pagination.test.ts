import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  encodeEventCursor,
  zEventCursor,
} from '../../../trpc/src/utils/event-cursor';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@openpanel/redis', () => ({ cacheable: (fn: unknown) => fn }));
vi.mock('../buffers', () => ({
  botBuffer: {},
  eventBuffer: {},
  sessionBuffer: {},
}));
vi.mock('../prisma-client', () => ({
  db: { customEvent: { findMany: async () => [] } },
}));
vi.mock('./chart.service', () => ({ getEventFiltersWhereClause: () => ({}) }));
vi.mock('./profile.service', () => ({
  getProfilesCached: vi.fn(),
  getProfilesWithoutTraitsCached: vi.fn(),
}));
vi.mock('../clickhouse/query-builder', () => ({ clix: {} }));
vi.mock('../clickhouse/client', () => ({
  ch: {},
  chQuery: mocks.query,
  TABLE_NAMES: { events: 'events' },
  formatClickhouseDate: (d: Date) =>
    d
      .toISOString()
      .replace('T', ' ')
      .replace(/(\.\d{3})?Z+$/, ''),
  convertClickhouseDateToJs: (s: string) => new Date(s.replace(' ', 'T') + 'Z'),
}));
import { getEventList } from './event.service';

// Opt-in integration: executes the actual service-generated SQL in an isolated
// ClickHouse container. No network and no production writes.
const container = process.env.OPENPANEL_PAGINATION_CH_CONTAINER;
const suite = container ? describe : describe.skip;
function query(sql: string) {
  return execFileSync(
    'docker',
    ['exec', '-i', container!, 'clickhouse-client', '--query', sql],
    { encoding: 'utf8' }
  );
}
suite('event pagination against ClickHouse', () => {
  beforeEach(() => {
    query('DROP TABLE IF EXISTS events');
    query(
      'CREATE TABLE events (id UUID, name String, project_id String, profile_id String, device_id String, session_id String, created_at DateTime64(3), path String, duration UInt32, city String, country String, os String, browser String) ENGINE=Memory'
    );
    query(
      `INSERT INTO events SELECT toUUID(concat('00000000-0000-4000-8000-', leftPad(toString(number),12,'0'))), if(number=51,'Subscription: Purchase Initiated','other'), 'regain-app', 'profile', '', '', toDateTime64('2026-09-23 12:30:33.724',3) - if(number<125,0,1), '', 0, '', '', '', '' FROM numbers(132)`
    );
    mocks.query.mockImplementation(async (sql: string) =>
      query(sql + ' FORMAT JSONEachRow')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((s) => JSON.parse(s))
    );
  });
  it('returns all same-millisecond events exactly once across 50-row pages', async () => {
    const ids: string[] = [];
    let cursor: { createdAt: Date; id: string } | undefined;
    for (let page = 0; page < 6; page++) {
      const rows = await getEventList({
        projectId: 'regain-app',
        profileId: 'profile',
        take: 50,
        cursor:
          process.env.OPENPANEL_PAGINATION_BASELINE === '1'
            ? cursor?.createdAt
            : cursor,
        startDate: new Date('2026-09-23'),
        endDate: new Date('2026-09-24'),
        select: {
          profile: false,
          meta: false,
          id: process.env.OPENPANEL_PAGINATION_BASELINE === '1',
        },
      });
      if (!rows.length) break;
      ids.push(...rows.map((r) => r.id));
      const last = rows.at(-1)!;
      cursor = zEventCursor.parse(encodeEventCursor(last)) as typeof cursor;
    }
    expect(ids.length).toBe(132);
    expect(new Set(ids).size).toBe(132);
    expect(ids).toContain('00000000-0000-4000-8000-000000000051');
  });
  it.skipIf(!process.env.OPENPANEL_PAGINATION_LIVE_FIXTURE)(
    'replays the read-only live profile snapshot without missing IDs',
    async () => {
      const rows = readFileSync(
        process.env.OPENPANEL_PAGINATION_LIVE_FIXTURE!,
        'utf8'
      )
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((s) => JSON.parse(s));
      query('TRUNCATE TABLE events');
      execFileSync(
        'docker',
        [
          'exec',
          '-i',
          container!,
          'clickhouse-client',
          '--query',
          'INSERT INTO events FORMAT JSONEachRow',
        ],
        {
          input: rows
            .map((r) =>
              JSON.stringify({
                ...r,
                project_id: 'regain-app',
                profile_id: 'profile',
              })
            )
            .join('\n'),
        }
      );
      async function collect(legacy: boolean) {
        const ids: string[] = [];
        let cursor: Date | { createdAt: Date; id: string } | undefined;
        for (let i = 0; i < 100; i++) {
          const page = await getEventList({
            projectId: 'regain-app',
            profileId: 'profile',
            take: 50,
            cursor,
            startDate: new Date('2026-09-01'),
            endDate: new Date('2026-10-01'),
            select: { profile: false, meta: false },
          });
          if (!page.length) return ids;
          ids.push(...page.map((r) => r.id));
          cursor =
            legacy || process.env.OPENPANEL_PAGINATION_BASELINE === '1'
              ? page.at(-1)!.createdAt
              : zEventCursor.parse(encodeEventCursor(page.at(-1)!));
        }
        throw new Error('Pagination did not terminate');
      }
      const oldIds = await collect(true);
      const newIds = await collect(false);
      console.log(
        'LIVE SNAPSHOT REPLAY',
        JSON.stringify({
          total: rows.length,
          timestampOnly: oldIds.length,
          fixed: newIds.length,
          omitted: rows
            .filter((r) => !oldIds.includes(r.id))
            .map((r) => ({ id: r.id, name: r.name, created_at: r.created_at })),
          purchases: rows
            .filter((r) => r.name === 'Subscription: Purchase Initiated')
            .map((r) => ({
              id: r.id,
              inTimestampOnly: oldIds.includes(r.id),
              inFixed: newIds.includes(r.id),
            })),
        })
      );
      expect(new Set(newIds)).toEqual(new Set(rows.map((r) => r.id)));
      expect(newIds.length).toBe(rows.length);
      for (const purchase of rows.filter(
        (r) => r.name === 'Subscription: Purchase Initiated'
      ))
        expect(newIds).toContain(purchase.id);
    },
    30000
  );
  it('preserves legacy Date and numeric cursors and event filtering', async () => {
    const options = {
      projectId: 'regain-app',
      take: 50,
      startDate: new Date('2026-09-23'),
      endDate: new Date('2026-09-24'),
      select: { profile: false, meta: false },
    };
    expect(
      await getEventList({
        ...options,
        cursor: new Date('2026-09-23T12:30:33.724Z'),
      })
    ).toHaveLength(7);
    expect(await getEventList({ ...options, cursor: 2 })).toHaveLength(32);
    const filtered = await getEventList({
      ...options,
      events: ['Subscription: Purchase Initiated'],
    });
    expect(filtered).toHaveLength(1);
  });
});

// Always-on query regressions; these run without Docker in the normal workspace.
describe('event pagination query contract', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValue([]);
  });
  const base = {
    projectId: 'regain-app',
    take: 50,
    dateIntervalInDays: 365,
    select: { profile: false, meta: false, id: false },
  };
  it('does not round the pagination timestamp down to the second', async () => {
    await getEventList({
      ...base,
      cursor: new Date('2026-09-23T12:30:33.724Z'),
    });
    expect(mocks.query.mock.calls[0][0]).toContain(
      "created_at < toDateTime64('2026-09-23 12:30:33.724', 3)"
    );
  });
  it('uses both ordering keys and selects the ID even when hidden', async () => {
    await getEventList({
      ...base,
      cursor: {
        createdAt: new Date('2026-09-23T12:30:33.724Z'),
        id: '00000000-0000-4000-8000-000000000051',
      },
    });
    const sql = mocks.query.mock.calls[0][0];
    expect(sql).toContain(
      "created_at = toDateTime64('2026-09-23 12:30:33.724', 3) AND id > toUUID('00000000-0000-4000-8000-000000000051')"
    );
    expect(sql).toContain('created_at DESC, id ASC');
    expect(sql.split('FROM')[0]).toMatch(/\bid\b/);
  });
});
