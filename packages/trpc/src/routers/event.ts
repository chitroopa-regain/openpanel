import { TRPCError } from '@trpc/server';
import sqlstring from 'sqlstring';
import { z } from 'zod';

import {
  type IServiceProfile,
  type IServiceSession,
  TABLE_NAMES,
  addDroppedEvent,
  chQuery,
  convertClickhouseDateToJs,
  db,
  deleteEventByName,
  eventService,
  getChartStartEndDate,
  getConversionEventNames,
  getEventList,
  getEventMetasCached,
  getSettingsForProject,
  pagesService,
  removeDroppedEvent,
  sessionService,
} from '@openpanel/db';
import {
  zChartEventFilter,
  zRange,
  zTimeInterval,
} from '@openpanel/validation';

import { clone } from 'ramda';
import { getProjectAccess } from '../access';
import { TRPCAccessError } from '../errors';
import { createTRPCRouter, protectedProcedure, publicProcedure } from '../trpc';

const PROTECTED_EVENTS = ['session_start', 'session_end', 'screen_view'];

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
        cursor: z.string().optional(),
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
        cursor: input.cursor ? new Date(input.cursor) : undefined,
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
              ? lastItem.createdAt.toISOString()
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
        cursor: z.string().optional(),
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
        cursor: input.cursor ? new Date(input.cursor) : undefined,
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
              ? lastItem.createdAt.toISOString()
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

  dropEvent: protectedProcedure
    .input(z.object({ projectId: z.string(), name: z.string() }))
    .mutation(async ({ input: { projectId, name } }) => {
      if (PROTECTED_EVENTS.includes(name)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot drop protected system event: ${name}`,
        });
      }
      // Redis first — enforcement takes effect immediately
      try {
        await addDroppedEvent(projectId, name);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to drop event: Redis is unavailable. Please try again.`,
        });
      }
      let meta;
      try {
        meta = await db.eventMeta.upsert({
          where: { name_projectId: { name, projectId } },
          create: { projectId, name, droppedAt: new Date() },
          update: { droppedAt: new Date() },
        });
      } catch (err) {
        // Rollback Redis on DB failure
        await removeDroppedEvent(projectId, name).catch(() => {});
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to drop event: database error. Please try again.`,
        });
      }
      await getEventMetasCached.clear(projectId);
      // Best-effort cleanup — fire and forget
      deleteEventByName(projectId, name).catch((err) =>
        console.error('ClickHouse cleanup failed for dropped event:', name, err)
      );
      return meta;
    }),

  undropEvent: protectedProcedure
    .input(z.object({ projectId: z.string(), name: z.string() }))
    .mutation(async ({ input: { projectId, name } }) => {
      const existing = await db.eventMeta.findUnique({
        where: { name_projectId: { name, projectId } },
      });
      if (!existing || !existing.droppedAt) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Event '${name}' is not currently dropped`,
        });
      }
      // Redis first — enforcement lifts immediately
      try {
        await removeDroppedEvent(projectId, name);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to undrop event: Redis is unavailable. Please try again.`,
        });
      }
      let meta;
      try {
        meta = await db.eventMeta.update({
          where: { name_projectId: { name, projectId } },
          data: { droppedAt: null, clearedAt: null },
        });
      } catch (err) {
        // Rollback Redis on DB failure
        await addDroppedEvent(projectId, name).catch(() => {});
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to undrop event: database error. Please try again.`,
        });
      }
      await getEventMetasCached.clear(projectId);
      return meta;
    }),

  clearDroppedEvent: protectedProcedure
    .input(z.object({ projectId: z.string(), name: z.string() }))
    .mutation(async ({ input: { projectId, name } }) => {
      const existing = await db.eventMeta.findUnique({
        where: { name_projectId: { name, projectId } },
      });
      if (!existing || !existing.droppedAt) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Event '${name}' is not currently dropped`,
        });
      }
      // Only stamp clearedAt after successful cleanup submission
      await deleteEventByName(projectId, name);
      await db.eventMeta.update({
        where: { name_projectId: { name, projectId } },
        data: { clearedAt: new Date() },
      });
      await getEventMetasCached.clear(projectId);
      return { ok: true };
    }),
});
