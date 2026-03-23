import { z } from 'zod';

import { db } from '@openpanel/db';
import { zCustomEventInput } from '@openpanel/validation';

import { getProjectAccess } from '../access';
import { TRPCAccessError } from '../errors';
import { createTRPCRouter, protectedProcedure } from '../trpc';

export const customEventRouter = createTRPCRouter({
  list: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
      })
    )
    .query(async ({ input: { projectId }, ctx }) => {
      const access = await getProjectAccess({
        userId: ctx.session.userId,
        projectId,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this project');
      }

      return db.customEvent.findMany({
        where: { projectId },
        orderBy: { name: 'asc' },
      });
    }),

  create: protectedProcedure
    .input(zCustomEventInput)
    .mutation(async ({ input, ctx }) => {
      const access = await getProjectAccess({
        userId: ctx.session.userId,
        projectId: input.projectId,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this project');
      }

      return db.customEvent.create({
        data: {
          name: input.name,
          projectId: input.projectId,
          components: input.components,
          color: input.color,
          icon: input.icon,
        },
      });
    }),

  update: protectedProcedure
    .input(
      zCustomEventInput.extend({
        id: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const existing = await db.customEvent.findUniqueOrThrow({
        where: { id: input.id },
      });

      const access = await getProjectAccess({
        userId: ctx.session.userId,
        projectId: existing.projectId,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this project');
      }

      return db.customEvent.update({
        where: { id: input.id },
        data: {
          name: input.name,
          components: input.components,
          color: input.color,
          icon: input.icon,
        },
      });
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input: { id }, ctx }) => {
      const existing = await db.customEvent.findUniqueOrThrow({
        where: { id },
      });

      const access = await getProjectAccess({
        userId: ctx.session.userId,
        projectId: existing.projectId,
      });

      if (!access) {
        throw TRPCAccessError('You do not have access to this project');
      }

      return db.customEvent.delete({
        where: { id },
      });
    }),
});
