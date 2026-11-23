import {
  dropManagedEvent,
  EventDropError,
  getReplayRequest,
  listEventDropAudit,
  listManagedEvents,
  MANAGED_EVENT_FILTERS,
  undropManagedEvent,
} from '@openpanel/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const zSource = z.enum(['UI', 'Agent']);

const zListQuery = z.object({
  filter: z.enum(MANAGED_EVENT_FILTERS).default('all'),
  q: z.string().optional(),
});

const zDropBody = z.object({
  name: z.string().min(1),
  confirmName: z.string(),
  reason: z.string().max(1000).optional().nullable(),
  source: zSource,
  requestedBy: z.string().max(200).optional().nullable(),
  chatUrl: z.string().max(2000).optional().nullable(),
});

const zUndropBody = zDropBody.omit({ reason: true }).extend({
  replay: z.boolean(),
  reason: z.string().max(1000).optional().nullable(),
});

const zAuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

type ProjectParams = { Params: { id: string } };

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof EventDropError) {
    return reply
      .status(error.httpStatus)
      .send({ error: error.code, message: error.message });
  }
  if (error instanceof z.ZodError) {
    return reply
      .status(400)
      .send({ error: 'INVALID_INPUT', message: error.issues[0]?.message ?? 'Invalid input', issues: error.issues });
  }
  throw error;
}

export async function listEvents(
  request: FastifyRequest<ProjectParams>,
  reply: FastifyReply
) {
  try {
    const query = zListQuery.parse(request.query ?? {});
    const result = await listManagedEvents({
      projectId: request.params.id,
      filter: query.filter,
      q: query.q,
    });
    return reply.send(result.events);
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function dropEvent(
  request: FastifyRequest<ProjectParams>,
  reply: FastifyReply
) {
  try {
    const body = zDropBody.parse(request.body ?? {});
    const result = await dropManagedEvent({
      ...body,
      projectId: request.params.id,
    });
    return reply.send(result);
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function undropEvent(
  request: FastifyRequest<ProjectParams>,
  reply: FastifyReply
) {
  try {
    const body = zUndropBody.parse(request.body ?? {});
    const result = await undropManagedEvent({
      ...body,
      projectId: request.params.id,
    });
    return reply.send(result);
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function getReplay(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const replay = await getReplayRequest(request.params.id);
    return reply.send({
      status: replay.status,
      copied: replay.copied,
      error: replay.error,
      projectId: replay.projectId,
      eventName: replay.eventName,
      fromTs: replay.fromTs,
      toTs: replay.toTs,
    });
  } catch (error) {
    return sendError(reply, error);
  }
}

export async function listAudit(
  request: FastifyRequest<ProjectParams>,
  reply: FastifyReply
) {
  try {
    const query = zAuditQuery.parse(request.query ?? {});
    return reply.send(await listEventDropAudit(request.params.id, query.limit));
  } catch (error) {
    return sendError(reply, error);
  }
}
