import crypto from 'node:crypto';

/**
 * `Authorization: Bearer <OPENPANEL_ADMIN_API_TOKEN>`. With the env var unset
 * every request is refused, so the API is off until a token is configured.
 */
export function isValidAdminToken(
  authorization: string | string[] | undefined,
  expected: string | undefined = process.env.OPENPANEL_ADMIN_API_TOKEN
): boolean {
  if (!expected || typeof authorization !== 'string') {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) {
    return false;
  }
  // Hash both sides so the comparison is constant time whatever the lengths.
  const given = crypto.createHash('sha256').update(match[1]!).digest();
  const wanted = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(given, wanted);
}
