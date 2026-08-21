import { COOKIE_OPTIONS, type SessionValidationResult } from '@openpanel/auth';
import { runWithAlsSession } from '@openpanel/db';
import { getAudienceEpoch } from '@openpanel/db';
import { getRedisCache } from '@openpanel/redis';
import type { ISetCookie } from '@openpanel/validation';
import { initTRPC, TRPCError } from '@trpc/server';
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import {
  createTrpcRedisLimiter,
  defaultFingerPrint,
} from '@trpc-limiter/redis';
import { has } from 'ramda';
import superjson from 'superjson';
import { ZodError } from 'zod';
import { getOrganizationAccess, getProjectAccess } from './access';
import { TRPCAccessError } from './errors';

export const rateLimitMiddleware = ({
  max,
  windowMs,
}: {
  max: number;
  windowMs: number;
}) =>
  createTrpcRedisLimiter<typeof t>({
    fingerprint: (ctx) => defaultFingerPrint(ctx.req),
    message: (hitInfo) =>
      `Too many requests, please try again later. ${hitInfo}`,
    max,
    windowMs,
    redisClient: getRedisCache(),
  });

export async function createContext({ req, res }: CreateFastifyContextOptions) {
  const cookies = (req as any).cookies as Record<string, string | undefined>;
  const setCookie: ISetCookie = (key, value, options) => {
    // @ts-ignore
    res.setCookie(key, value, {
      maxAge: options.maxAge,
      ...COOKIE_OPTIONS,
    });
  };

  if (process.env.NODE_ENV !== 'production') {
    await new Promise((res) =>
      setTimeout(() => res(1), Math.min(Math.random() * 500, 200))
    );
  }

  return {
    req,
    res,
    session: (req as any).session as SessionValidationResult,
    // we do not get types for `setCookie` from fastify
    // so define it here and be safe in routers
    setCookie,
    cookies,
  };
}
export type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

const enforceUserIsAuthed = t.middleware(async ({ ctx, next }) => {
  if (!ctx.session?.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
  }

  try {
    return next({
      ctx: {
        session: { ...ctx.session },
      },
    });
  } catch (error) {
    console.error('Failes to get user', error);
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Failed to get user',
    });
  }
});

// Only used on protected routes
const enforceAccess = t.middleware(async ({ ctx, next, type, getRawInput }) => {
  const sessionId = ctx.session?.session?.id ?? null;
  return runWithAlsSession(sessionId, async () => {
    const rawInput = await getRawInput();
    if (type === 'mutation' && process.env.DEMO_USER_ID) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You are not allowed to do this in demo mode',
      });
    }

    if (has('projectId', rawInput)) {
      const access = await getProjectAccess({
        userId: ctx.session.userId!,
        projectId: rawInput.projectId as string,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this project');
      }
    }

    if (has('organizationId', rawInput)) {
      const access = await getOrganizationAccess({
        userId: ctx.session.userId!,
        organizationId: rawInput.organizationId as string,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this organization');
      }
    }

    return next();
  });
});

export const createTRPCRouter = t.router;

const loggerMiddleware = t.middleware(
  async ({ ctx, next, getRawInput, path, input, type }) => {
    const rawInput = await getRawInput();
    // Only log mutations
    if (type === 'mutation') {
      ctx.req.log.info('TRPC mutation', {
        path,
        rawInput,
        input,
        userId: ctx.session?.userId,
        organizationId: has('organizationId', rawInput)
          ? rawInput.organizationId
          : undefined,
        projectId: has('projectId', rawInput) ? rawInput.projectId : undefined,
      });
    }
    return next();
  }
);

const sessionScopeMiddleware = t.middleware(async ({ ctx, next }) => {
  const sessionId = ctx.session?.session?.id ?? null;
  return runWithAlsSession(sessionId, async () => {
    return next();
  });
});

export const publicProcedure = t.procedure
  .use(loggerMiddleware)
  .use(sessionScopeMiddleware);
export const protectedProcedure = t.procedure
  .use(enforceUserIsAuthed)
  .use(enforceAccess)
  .use(loggerMiddleware)
  .use(sessionScopeMiddleware);

const middlewareMarker = 'middlewareMarker' as 'middlewareMarker' & {
  __brand: 'middlewareMarker';
};

// Hard eviction TTL is derived from the freshness window: an entry lives
// long enough that the team keeps serving (and revalidating) it, but is
// eventually evicted so a cold cache recomputes from scratch.
const HARD_TTL_MULTIPLIER = 20;
const MIN_HARD_TTL = 60 * 60 * 24; // 1 day
const MAX_HARD_TTL = 60 * 60 * 24 * 14; // 14 days

// Cache hits are served in every environment (prod, staging, local). Set
// OP_QUERY_CACHE=0 as a kill-switch to disable — e.g. if it misbehaves in prod,
// or while editing query SQL locally (the cache key is the report input, not
// the code, so a cached result survives a query-code change). The manual
// refresh button forces a per-report recompute without disabling the cache.
function isQueryCacheEnabled() {
  return process.env.OP_QUERY_CACHE !== '0';
}

// Redis envelope: the cached payload plus the epoch-ms it was computed at.
type CacheEnvelope = { t: number; d: unknown };

function isEnvelope(value: unknown): value is CacheEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    't' in value &&
    'd' in value &&
    typeof (value as CacheEnvelope).t === 'number'
  );
}

// Surface cache age to the client so it can render "Updated X ago" and decide
// whether to background-revalidate. Only plain objects carry it (the heavy
// report endpoints all return objects); primitives/arrays pass through as-is.
//
// NOTE: a top-level ARRAY payload gets no `_cache`, so the client never sees
// `stale` and SWR auto-revalidation is silently disabled for it. All currently
// cached endpoints return objects, so this is fine today — but wrap array
// payloads (e.g. `{ d: data, _cache }`) before adding a new array-returning
// report to this middleware, or it won't refresh.
function attachCacheMeta(data: unknown, cachedAt: number, stale: boolean) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return {
      ...(data as Record<string, unknown>),
      _cache: { cachedAt, stale },
    };
  }
  return data;
}

// Fields that must NOT be part of the cache key: cache-control (bypassCache),
// editor UI state (ready/dirty), display-only (name/lineType/unit/layout),
// identity/access (id/shareId), and pagination defaults the editor injects
// (limit/offset). Stripped at the top level only — nested `name` (event names),
// `id` (series handles) etc. still matter and are preserved. Without this, the
// same report fragments into different entries in the dashboard grid vs the
// editor → inconsistent "Updated X ago" and duplicate ClickHouse queries.
const NON_QUERY_KEY_FIELDS = new Set([
  'bypassCache',
  'ready',
  'dirty',
  'name',
  'lineType',
  'unit',
  'layout',
  'id',
  'shareId',
  'limit',
  'offset',
]);

// Recursively sort object keys so field order can't fragment the key.
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  // Serialize Dates explicitly — otherwise the object branch below would turn
  // them into `{}` (Object.keys(date) is empty), collapsing distinct dates to
  // the same key.
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

function canonicalKey(input: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (NON_QUERY_KEY_FIELDS.has(k)) {
      continue;
    }
    if (k === 'options' && v && typeof v === 'object' && !Array.isArray(v)) {
      const { displayMode: _displayMode, ...queryOptions } = v as Record<
        string,
        unknown
      >;
      if (queryOptions.type !== 'generic') {
        filtered[k] = queryOptions;
      }
      continue;
    }
    filtered[k] = v;
  }
  return JSON.stringify(sortKeysDeep(filtered));
}

export const cacheMiddleware = (
  cbOrTtl: number | ((input: any, opts: { path: string }) => number)
) =>
  t.middleware(async ({ ctx, next, path, type, getRawInput, input }) => {
    // The callback now returns the *freshness window* (seconds), not the TTL.
    const freshness =
      typeof cbOrTtl === 'function' ? cbOrTtl(input, { path }) : cbOrTtl;
    if (!freshness || type !== 'query' || !isQueryCacheEnabled()) {
      return next();
    }

    const rawInput = (await getRawInput()) as
      | (Record<string, unknown> & { bypassCache?: boolean; shareId?: string })
      | undefined;
    // Only authenticated viewers may force a recompute. Public share / embed
    // views go through the same public procedure, so honoring bypassCache there
    // would let an anonymous viewer hammer ClickHouse (the single-flight lock
    // caps concurrency, not frequency). They always get the shared cached value.
    const bypass = rawInput?.bypassCache === true && !rawInput?.shareId;

    // Audience epoch: a token that changes whenever any custom cohort or custom
    // event definition changes. Mixed into EVERY cached report key, not only
    // keys whose input mentions an audience — a saved-report request carries
    // just `{id: reportId}` and loads its definition server-side, so an
    // audience-conditional key would be bypassed exactly where it matters.
    //
    // Fail closed: if the token cannot be read we skip the cache entirely
    // rather than build a key without it, since a key missing the epoch would
    // collide with entries computed under a different cohort definition.
    let epoch: string;
    try {
      epoch = await getAudienceEpoch();
    } catch {
      return next();
    }

    // Canonical key: same logical query → same entry across every view.
    let key = `trpc:${epoch}:${path}:`;
    if (rawInput) {
      key += canonicalKey(rawInput).replace(/"/g, "'");
    }

    const hardTtl = Math.min(
      MAX_HARD_TTL,
      Math.max(MIN_HARD_TTL, freshness * HARD_TTL_MULTIPLIER)
    );

    const store = (data: unknown) => {
      if (data === undefined || data === null) {
        return;
      }
      getRedisCache()
        .setJson(key, hardTtl, {
          t: Date.now(),
          d: data,
        } satisfies CacheEnvelope)
        .catch(() => {});
    };

    const read = async (): Promise<CacheEnvelope | null> => {
      const cached = await getRedisCache().getJson(key);
      return isEnvelope(cached) ? cached : null;
    };

    const computeAndStore = async () => {
      const result = await next();
      // @ts-expect-error result.data is present on an ok result
      const data = result.data;
      if (data) {
        store(data);
        // @ts-expect-error attach age metadata to the freshly computed payload
        result.data = attachCacheMeta(data, Date.now(), false);
      }
      return result;
    };

    // Forced refresh (manual button or client-driven revalidation): bypass the
    // read, recompute, and overwrite the shared entry. A single-flight lock
    // collapses concurrent revalidations of the same key into one ClickHouse
    // query; the losers serve the existing stale value instead of piling on.
    if (bypass) {
      const lockKey = `${key}:lock`;
      const gotLock = await getRedisCache().set(lockKey, '1', 'EX', 30, 'NX');
      if (!gotLock) {
        const env = await read();
        if (env) {
          return {
            ok: true,
            data: attachCacheMeta(env.d, env.t, true),
            ctx,
            marker: middlewareMarker,
          };
        }
      }
      const result = await computeAndStore();
      if (gotLock) {
        getRedisCache()
          .del(lockKey)
          .catch(() => {});
      }
      return result;
    }

    // Normal read: serve the cached value instantly, flagged stale when it has
    // aged past its freshness window so the client knows to revalidate.
    const env = await read();
    if (env) {
      const stale = Date.now() - env.t > freshness * 1000;
      return {
        ok: true,
        data: attachCacheMeta(env.d, env.t, stale),
        ctx,
        marker: middlewareMarker,
      };
    }

    // Cold cache: compute, store, return fresh.
    return computeAndStore();
  });
