import * as controller from '@/controllers/event-drop.controller';
import { isValidAdminToken } from '@/utils/admin-token';
import { activateRateLimiter } from '@/utils/rate-limiter';
import type { FastifyPluginCallback } from 'fastify';

/**
 * Event drop management for admins and agents, under /manage:
 *   GET  /projects/:id/events?filter=&q=
 *   POST /projects/:id/events/drop
 *   POST /projects/:id/events/undrop
 *   POST /projects/:id/events/keep   { name, keep, note } (Keep mark)
 *   GET  /projects/:id/audit?limit=
 * Auth: Authorization: Bearer $OPENPANEL_ADMIN_API_TOKEN (401 otherwise).
 * Registered as its own plugin so the root-client hook of manage.router does
 * not apply; the params are named `:id` to match manage.router's routes.
 */
const eventDropRouter: FastifyPluginCallback<{ rateLimit?: boolean }> = async (
  fastify,
  opts
) => {
  if (opts.rateLimit !== false) {
    await activateRateLimiter({
      fastify,
      max: 30,
      timeWindow: '10 seconds',
    });
  }

  fastify.addHook('onRequest', async (req, reply) => {
    if (!isValidAdminToken(req.headers.authorization)) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Missing or invalid admin token',
      });
    }
  });

  fastify.route({
    method: 'GET',
    url: '/projects/:id/events',
    handler: controller.listEvents,
  });

  fastify.route({
    method: 'POST',
    url: '/projects/:id/events/drop',
    handler: controller.dropEvent,
  });

  fastify.route({
    method: 'POST',
    url: '/projects/:id/events/undrop',
    handler: controller.undropEvent,
  });

  fastify.route({
    method: 'POST',
    url: '/projects/:id/events/keep',
    handler: controller.keepEvent,
  });

  fastify.route({
    method: 'GET',
    url: '/projects/:id/audit',
    handler: controller.listAudit,
  });
};

export default eventDropRouter;
