import { TRPCError } from '@trpc/server';
import sqlstring from 'sqlstring';
import { z } from 'zod';

import {
  type IServiceProfile,
  type IServiceSession,
  TABLE_NAMES,
  chQuery,
  convertClickhouseDateToJs,
  db,
  eventService,
  getChartStartEndDate,
  getConversionEventNames,
  getEventList,
  getEventMetasCached,
  getSettingsForProject,
  pagesService,
  EventDropError,
  MANAGED_EVENT_FILTERS,
  dropManagedEvent,
  getDropNotes,
  listEventDropAudit,
  listManagedEvents,
  recordResourceView,
  undropManagedEvent,
  setEventKeep,
  KEEP_NOTE_MAX_LENGTH,
  sessionService,
} from '@openpanel/db';
import {
  zChartEventFilter,
  zDateConfig,
  zRange,
  zTimeInterval,
} from '@openpanel/validation';

import { clone } from 'ramda';
import { getProjectAccess } from '../access';
import { TRPCAccessError } from '../errors';
import { createTRPCRouter, protectedProcedure, publicProcedure } from '../trpc';
import { encodeEventCursor, zEventCursor } from '../utils/event-cursor';

const DROP_ERROR_TO_TRPC = {
  400: 'BAD_REQUEST',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  503: 'INTERNAL_SERVER_ERROR',
} as const;

/** Same service functions as the REST /manage API; map their errors to tRPC. */
async function withDropErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof EventDropError) {
      throw new TRPCError({
        code:
          DROP_ERROR_TO_TRPC[
            error.httpStatus as keyof typeof DROP_ERROR_TO_TRPC
          ] ?? 'INTERNAL_SERVER_ERROR',
        message: error.message,
        cause: error,
      });
    }
    throw error;
  }
}

export const eventRouter = createTRPCRouter({
  updateEventMeta: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string(),
        icon: z.string().optional(),
        color: z.string().optional(),
        conversion: z.boolean().optional(),
      }),
    )
    .mutation(
      async ({ input: { projectId, name, icon, color, conversion } }) => {
        await getEventMetasCached.clear(projectId);
        return db.eventMeta.upsert({
          where: {
            name_projectId: {
              name,
              projectId,
            },
          },
          create: { projectId, name, icon, color, conversion },
          update: { icon, color, conversion },
        });
      },
    ),

  byId: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        projectId: z.string(),
        createdAt: z.date().optional(),
      }),
    )
    .query(async ({ input: { id, projectId, createdAt } }) => {
      const res = await eventService.getById({
        projectId,
        id,
        createdAt,
      });

      if (!res) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Event not found',
        });
      }

      return res;
    }),

  details: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        projectId: z.string(),
        createdAt: z.date().optional(),
      }),
    )
    .query(async ({ input: { id, projectId, createdAt } }) => {
      const res = await eventService.getById({
        projectId,
        id,
        createdAt,
      });

      if (!res) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Event not found',
        });
      }

      let session: IServiceSession | undefined;
      if (res?.sessionId) {
        session = await sessionService
          .byId(res?.sessionId, projectId)
          .catch(() => undefined);
      }

      return {
        event: res,
        session,
      };
    }),

  events: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        profileId: z.string().optional(),
        sessionId: z.string().optional(),
        cursor: zEventCursor.optional(),
        filters: z.array(zChartEventFilter).default([]),
        startDate: z.date().optional(),
        endDate: z.date().optional(),
        events: z.array(z.string()).optional(),
        columnVisibility: z.record(z.string(), z.boolean()).optional(),
      }),
    )
    .query(async ({ input: { columnVisibility, ...input } }) => {
      const items = await getEventList({
        ...input,
        take: 50,
        cursor: input.cursor,
        select: {
          ...columnVisibility,
          city: columnVisibility?.country ?? true,
          path: columnVisibility?.name ?? true,
          duration: columnVisibility?.name ?? true,
          projectId: false,
          revenue: true,
        },
        // Events listing table renders name/avatar/email — never touches
        // `profile.properties.*`. Skipping the traits scan drops ~800 ms
        // of ClickHouse work per call (see scratchpad/events_baseline.md).
        includeProfileTraits: false,
      });

      // Hacky join to get profile for entire session
      // TODO: Replace this with a join on the session table
      const map = new Map<string, IServiceProfile>(); // sessionId -> profileId
      for (const item of items) {
        if (item.sessionId && item.profile?.isExternal === true) {
          map.set(item.sessionId, item.profile);
        }
      }

      for (const item of items) {
        const profile = map.get(item.sessionId);
        if (profile && (item.profile?.isExternal === false || !item.profile)) {
          item.profile = clone(profile);
          if (item?.profile?.firstName) {
            item.profile.firstName = `* ${item.profile.firstName}`;
          }
        }
      }

      const lastItem = items[items.length - 1];

      return {
        data: items,
        meta: {
          next:
            items.length > 0 && lastItem
              ? encodeEventCursor(lastItem)
              : null,
        },
      };
    }),
  conversionNames: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input: { projectId } }) => {
      return getConversionEventNames(projectId);
    }),
  conversions: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        cursor: zEventCursor.optional(),
        startDate: z.date().optional(),
        endDate: z.date().optional(),
        events: z.array(z.string()).optional(),
        columnVisibility: z.record(z.string(), z.boolean()).optional(),
      }),
    )
    .query(async ({ input: { columnVisibility, ...input } }) => {
      const conversions = await getConversionEventNames(input.projectId);
      const filteredConversions = conversions.filter((event) => {
        if (input.events && input.events.length > 0) {
          return input.events.includes(event.name);
        }
        return true;
      });

      if (filteredConversions.length === 0) {
        return {
          data: [],
          meta: {
            next: null,
          },
        };
      }

      const items = await getEventList({
        ...input,
        take: 50,
        cursor: input.cursor,
        select: {
          ...columnVisibility,
          city: columnVisibility?.country ?? true,
          path: columnVisibility?.name ?? true,
          duration: columnVisibility?.name ?? true,
          projectId: false,
          revenue: true,
        },
        custom: (sb) => {
          sb.where.name = `name IN (${filteredConversions.map((event) => sqlstring.escape(event.name)).join(',')})`;
        },
      });

      // Hacky join to get profile for entire session
      // TODO: Replace this with a join on the session table
      const map = new Map<string, IServiceProfile>(); // sessionId -> profileId
      for (const item of items) {
        if (item.sessionId && item.profile?.isExternal === true) {
          map.set(item.sessionId, item.profile);
        }
      }

      for (const item of items) {
        const profile = map.get(item.sessionId);
        if (profile && (item.profile?.isExternal === false || !item.profile)) {
          item.profile = clone(profile);
          if (item?.profile?.firstName) {
            item.profile.firstName = `* ${item.profile.firstName}`;
          }
        }
      }

      const lastItem = items[items.length - 1];

      return {
        data: items,
        meta: {
          next:
            items.length > 0 && lastItem
              ? encodeEventCursor(lastItem)
              : null,
        },
      };
    }),

  bots: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        cursor: z.number().optional(),
        limit: z.number().default(8),
      }),
    )
    .query(async ({ input: { projectId, cursor, limit }, ctx }) => {
      if (ctx.session.userId) {
        const access = await getProjectAccess({
          projectId,
          userId: ctx.session.userId,
        });
        if (!access) {
          throw TRPCAccessError('You do not have access to this project');
        }
      } else {
        const share = await db.shareOverview.findFirst({
          where: {
            projectId,
          },
        });

        if (!share) {
          throw TRPCAccessError('You do not have access to this project');
        }
      }

      const [events, counts] = await Promise.all([
        chQuery<{
          id: string;
          project_id: string;
          name: string;
          type: string;
          path: string;
          created_at: string;
        }>(
          `SELECT * FROM ${TABLE_NAMES.events_bots} WHERE project_id = ${sqlstring.escape(projectId)} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${(cursor ?? 0) * limit}`,
        ),
        chQuery<{
          count: number;
        }>(
          `SELECT count(*) as count FROM ${TABLE_NAMES.events_bots} WHERE project_id = ${sqlstring.escape(projectId)}`,
        ),
      ]);

      return {
        data: events.map((item) => ({
          ...item,
          createdAt: convertClickhouseDateToJs(item.created_at),
        })),
        count: counts[0]?.count ?? 0,
      };
    }),

  pages: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        cursor: z.number().optional(),
        take: z.number().default(20),
        search: z.string().optional(),
        range: zRange,
        interval: zTimeInterval,
      }),
    )
    .query(async ({ input }) => {
      const { timezone } = await getSettingsForProject(input.projectId);
      const { startDate, endDate } = getChartStartEndDate(input, timezone);
      return pagesService.getTopPages({
        projectId: input.projectId,
        startDate,
        endDate,
        timezone,
        search: input.search,
      });
    }),

  origin: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
      }),
    )
    .query(async ({ input }) => {
      const res = await chQuery<{ origin: string }>(
        `SELECT DISTINCT origin, count(id) as count FROM ${TABLE_NAMES.events} WHERE project_id = ${sqlstring.escape(
          input.projectId,
        )} AND origin IS NOT NULL AND origin != '' AND toDate(created_at) > now() - INTERVAL 30 DAY GROUP BY origin ORDER BY count DESC LIMIT 3`,
      );

      return res.filter((item) => item.origin && !item.origin.includes('localhost:'));
    }),

  managedEvents: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        filter: z.enum(MANAGED_EVENT_FILTERS).default('all'),
        q: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      return withDropErrors(() => listManagedEvents(input));
    }),

  eventDropAudit: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        limit: z.number().int().min(1).max(500).default(100),
      })
    )
    .query(async ({ input }) => {
      return listEventDropAudit(input.projectId, input.limit);
    }),

  dropEvent: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1),
        confirmName: z.string(),
        reason: z.string().max(1000).optional(),
      })
    )
    .mutation(async ({ input }) => {
      return withDropErrors(() =>
        dropManagedEvent({ ...input, source: 'UI' })
      );
    }),

  undropEvent: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1),
        confirmName: z.string(),
        reason: z.string().max(1000).optional(),
      })
    )
    .mutation(async ({ input }) => {
      return withDropErrors(() =>
        undropManagedEvent({ ...input, source: 'UI' })
      );
    }),

  keepEvent: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        name: z.string().min(1),
        keep: z.boolean(),
        note: z.string().max(KEEP_NOTE_MAX_LENGTH).optional(),
      })
    )
    .mutation(async ({ input }) => {
      return withDropErrors(() => setEventKeep({ ...input, source: 'UI' }));
    }),

  /**
   * "Event dropped" notes for every report of a board (or one report), in one
   * batched call. Input dates are the board/editor override.
   */
  dropNotes: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        dashboardId: z.string().optional(),
        reportId: z.string().uuid().optional(),
        /** The report editor's current, maybe unsaved, series and options. */
        draft: z
          .object({
            events: z.array(z.unknown()).max(50),
            options: z.unknown().optional(),
            cohortFilters: z.unknown().optional(),
            cohortBreakdown: z.unknown().optional(),
          })
          .optional(),
        range: zRange.nullish(),
        startDate: z.string().nullish(),
        endDate: z.string().nullish(),
        dateConfig: zDateConfig.nullish(),
      })
    )
    .query(async ({ input }) => getDropNotes(input)),

  /** Board/report opened: feeds "last viewed" and active/idle on the Events page. */
  recordView: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        resourceType: z.enum(['dashboard', 'report']),
        resourceId: z.string().min(1).max(64),
      })
    )
    .mutation(async ({ input }) => {
      await recordResourceView(input).catch(() => {});
      return { ok: true };
    }),
});
