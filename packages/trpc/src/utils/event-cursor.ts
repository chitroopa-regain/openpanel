import { z } from 'zod';

// Keep the wire cursor a string: callers pass meta.next through unchanged.
// Legacy ISO cursors remain accepted, but cannot recover already-skipped ties.
const composite = z.tuple([
  z.literal('v1'),
  z.string().datetime(),
  z.string().uuid(),
]);
export const zEventCursor = z.string().transform((value, ctx) => {
  if (value.startsWith('v1|')) {
    const parsed = composite.safeParse(value.split('|'));
    if (parsed.success) {
      return { createdAt: new Date(parsed.data[1]), id: parsed.data[2] };
    }
  } else {
    const parsed = z.string().datetime().safeParse(value);
    if (parsed.success) return new Date(parsed.data);
  }
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'Invalid event cursor',
  });
  return z.NEVER;
});

export function encodeEventCursor(event: {
  createdAt: Date;
  id: string;
}): string {
  return `v1|${event.createdAt.toISOString()}|${event.id}`;
}
