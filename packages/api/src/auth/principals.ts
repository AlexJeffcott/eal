import type { DatabaseClient } from '../db/client.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { createSessionsRepo } from './sessions.ts';

export interface Principal {
  readonly userId: number;
  readonly displayName: string;
}

function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  const match = trimmed.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

/**
 * The production provider seam. Reads `Authorization: Bearer <token>`, looks
 * up the session, looks up the user, returns the principal or null.
 *
 * Wholly synchronous; no network, no async. Tests swap this for an override
 * via `createTestApp(db, { principalOverride })` — see Step 4.
 */
export function getPrincipal(
  request: Request,
  db: DatabaseClient,
): Principal | null {
  const token = parseBearerToken(request.headers.get('authorization'));
  if (!token) return null;

  const sessions = createSessionsRepo(db);
  const session = sessions.verify(token);
  if (!session) return null;

  const user = createUsersRepo(db).findById(session.user_id);
  if (!user) return null;

  return { userId: user.id, displayName: user.display_name };
}

export type GetPrincipalFn = (request: Request) => Principal | null;
