import type { ClickHouseSettings, ResponseJSON } from '@clickhouse/client';
import { ClickHouseLogLevel, createClient } from '@clickhouse/client';
import type { NodeClickHouseClientConfigOptions } from '@clickhouse/client/dist/config';
import { createLogger } from '@openpanel/logger';
import type { IInterval } from '@openpanel/validation';
import sqlstring from 'sqlstring';

export { createClient };

const logger = createLogger({ name: 'clickhouse' });

import type { Logger } from '@clickhouse/client';
import { getSafeJson } from '@openpanel/json';

// All three LogParams types are exported by the client
interface LogParams {
  module: string;
  message: string;
  args?: Record<string, unknown>;
}
type ErrorLogParams = LogParams & { err: Error };
type WarnLogParams = LogParams & { err?: Error };

class CustomLogger implements Logger {
  trace({ message, args }: LogParams) {
    logger.debug(message, args);
  }
  debug({ message, args }: LogParams) {
    if (message.includes('Query:') && args?.response_status === 200) {
      return;
    }
    logger.debug(message, args);
  }
  info({ message, args }: LogParams) {
    logger.info(message, args);
  }
  warn({ message, args }: WarnLogParams) {
    logger.warn(message, args);
  }
  error({ message, args, err }: ErrorLogParams) {
    logger.error(message, {
      ...args,
      error: err,
    });
  }
}

export const TABLE_NAMES = {
  events: 'events',
  profiles: 'profiles',
  profile_traits: 'profile_traits',
  alias: 'profile_aliases',
  self_hosting: 'self_hosting',
  events_bots: 'events_bots',
  dau_mv: 'dau_mv',
  event_names_mv: 'distinct_event_names_mv',
  event_property_values_mv: 'event_property_values_mv',
  cohort_events_mv: 'cohort_events_mv',
  event_profile_firsts: 'event_profile_firsts_local',
  // Exact per-day identified timestamps (Array) at the same grain — replaces
  // the (min, max) approximation for funnels once backfilled. See
  // packages/db/scripts/mv/README.md.
  event_profile_ts: 'event_profile_ts_local',
  // Picker-backing key views (packages/db/scripts/mv/picker_keys.sql).
  event_property_keys: 'event_property_keys_local',
  profile_trait_keys: 'profile_trait_keys_local',
  profile_trait_values: 'profile_trait_values_local',
  sessions: 'sessions',
  events_imports: 'events_imports',
  session_replay_chunks: 'session_replay_chunks',
};

/**
 * Check if ClickHouse is running in clustered mode
 * Clustered mode = production (not self-hosted)
 * Non-clustered mode = self-hosted environments
 */
export function isClickhouseClustered(): boolean {
  if (
    process.env.CLICKHOUSE_CLUSTER === 'true' ||
    process.env.CLICKHOUSE_CLUSTER === '1'
  ) {
    return true;
  }

  return !(
    process.env.SELF_HOSTED === 'true' || process.env.SELF_HOSTED === '1'
  );
}

/**
 * Get the replicated table name for mutations
 * In clustered mode, returns table_name_replicated
 * In non-clustered mode, returns the original table name
 */
export function getReplicatedTableName(tableName: string): string {
  if (isClickhouseClustered()) {
    return `${tableName}_replicated ON CLUSTER '{cluster}'`;
  }
  return tableName;
}

function getClickhouseSettings(): ClickHouseSettings {
  const additionalSettings =
    getSafeJson<ClickHouseSettings>(process.env.CLICKHOUSE_SETTINGS || '{}') ||
    {};

  return {
    distributed_product_mode: 'allow',
    date_time_input_format: 'best_effort',
    ...(process.env.CLICKHOUSE_SETTINGS_REMOVE_CONVERT_ANY_JOIN
      ? {}
      : {
          query_plan_convert_any_join_to_semi_or_anti_join: 0,
        }),
    ...additionalSettings,
  };
}

export const CLICKHOUSE_OPTIONS: NodeClickHouseClientConfigOptions = {
  max_open_connections: 30,
  request_timeout: 300_000,
  keep_alive: {
    enabled: true,
    idle_socket_ttl: 60_000,
  },
  compression: {
    request: true,
  },
  clickhouse_settings: getClickhouseSettings(),
  log: {
    LoggerClass: CustomLogger,
    level: ClickHouseLogLevel.DEBUG,
  },
};

logger.info('Clickhouse options', CLICKHOUSE_OPTIONS);

export const originalCh = createClient({
  url: process.env.CLICKHOUSE_URL,
  ...CLICKHOUSE_OPTIONS,
});

const cleanQuery = (query?: string) =>
  typeof query === 'string'
    ? query.replace(/\n/g, '').replace(/\s+/g, ' ').trim()
    : undefined;

export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 500
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await operation();
      if (attempt > 0) {
        logger.info('Retry operation succeeded', { attempt });
      }
      return res;
    } catch (error: any) {
      lastError = error;

      if (
        error.message.includes('Connect') ||
        error.message.includes('socket hang up') ||
        error.message.includes('Timeout error')
      ) {
        const delay = baseDelay * 2 ** attempt;
        logger.warn(
          `Attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delay}ms`,
          {
            error: error.message,
          }
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw error; // Non-retriable error
    }
  }

  throw lastError;
}

/**
 * Bounded concurrency for read queries.
 *
 * A dashboard open fires every widget's query at once — 30-40 funnels and
 * retention grids against an 8-core ClickHouse node. Each query is planned
 * with max_threads = cores, so they oversubscribe the CPU together and ALL
 * take 20-40 s, while the same set run six at a time finishes in the same
 * total wall-clock with individual latencies back at their 1-5 s cost. It also
 * bounds peak memory: N concurrent × 6 GiB per-query limit must stay under the
 * server's ~29 GiB, which 34-way concurrency does not.
 *
 * OP_CH_MAX_CONCURRENT_QUERIES=0 (default) leaves it unbounded. Inserts and
 * commands are never queued.
 */
class QuerySemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.limit <= 0) return fn();
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }

  get pending() {
    return this.waiters.length;
  }
}

export const querySemaphore = new QuerySemaphore(
  Number(process.env.OP_CH_MAX_CONCURRENT_QUERIES) || 0,
);

export const ch = new Proxy(originalCh, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);

    if (property === 'query') {
      return (...args: any[]) =>
        querySemaphore.run(() => withRetry(() => value.apply(target, args)));
    }

    if (property === 'insert') {
      return (...args: any[]) =>
        withRetry(() => {
          args[0].clickhouse_settings = {
            // Increase insert timeouts and buffer sizes for large batches
            max_execution_time: 300,
            max_insert_block_size: '500000',
            max_http_get_redirects: '0',
            // Ensure JSONEachRow stays efficient
            input_format_parallel_parsing: 1,
            // Keep long-running inserts/queries from idling out at proxies by sending progress headers
            send_progress_in_http_headers: 1,
            http_headers_progress_interval_ms: '50000',
            // Ensure server holds the connection until the query is finished
            wait_end_of_query: 1,
            ...args[0].clickhouse_settings,
          };
          return value.apply(target, args);
        });
    }

    if (property === 'command') {
      return (...args: any[]) =>
        withRetry(() => {
          return value.apply(target, args);
        });
    }

    return value;
  },
});

export async function chQueryWithMeta<T extends Record<string, any>>(
  query: string,
  clickhouseSettings?: ClickHouseSettings
): Promise<ResponseJSON<T>> {
  const start = Date.now();
  const res = await ch.query({
    query,
    clickhouse_settings: clickhouseSettings,
  });
  const json = await res.json<T>();
  const keys = Object.keys(json.data[0] || {});
  const response = {
    ...json,
    data: json.data.map((item) => {
      return keys.reduce((acc, key) => {
        const meta = json.meta?.find((m) => m.name === key);
        return {
          ...acc,
          [key]:
            item[key] && meta?.type.includes('Int')
              ? Number.parseFloat(item[key] as string)
              : item[key],
        };
      }, {} as T);
    }),
  };

  logger.info('query info', {
    query: cleanQuery(query),
    rows: json.rows,
    stats: response.statistics,
    elapsed: Date.now() - start,
    clickhouseSettings,
  });

  return response;
}

export async function chQuery<T extends Record<string, any>>(
  query: string,
  clickhouseSettings?: ClickHouseSettings
): Promise<T[]> {
  return (await chQueryWithMeta<T>(query, clickhouseSettings)).data;
}

export function formatClickhouseDate(
  date: Date | string,
  skipTime = false
): string {
  if (skipTime) {
    return new Date(date).toISOString().split('T')[0]!;
  }
  return new Date(date)
    .toISOString()
    .replace('T', ' ')
    .replace(/(\.\d{3})?Z+$/, '');
}

export function toDate(str: string, interval?: IInterval) {
  // If it does not match the regex it's a column name eg 'created_at'
  if (!interval || interval === 'minute' || interval === 'hour') {
    if (str.match(/\d{4}-\d{2}-\d{2}/)) {
      return sqlstring.escape(str);
    }

    return str;
  }

  if (str.match(/\d{4}-\d{2}-\d{2}/)) {
    return `toDate(${sqlstring.escape(str.split(' ')[0])})`;
  }

  return `toDate(${str})`;
}

export function convertClickhouseDateToJs(date: string) {
  return new Date(`${date.replace(' ', 'T')}Z`);
}

const ROLLUP_DATE_PREFIX = '1970-01-01';
export function isClickhouseDefaultMinDate(date: string): boolean {
  return date.startsWith(ROLLUP_DATE_PREFIX) || date.startsWith('1969-12-31');
}
