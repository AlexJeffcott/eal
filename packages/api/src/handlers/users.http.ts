import { Elysia } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import { createUsersRepo } from '../db/repos/users.ts';
import { AuthError } from './auth.shared.ts';

export interface UsersRoutesContext {
  db: DatabaseClient;
  getPrincipal: (request: Request) => Principal | null;
}

/**
 * One route: the SPA loads the household roster so the task editor can offer an
 * assignee picker. Auth-gated like everything under /api.
 */
export function usersHttpRoutes(ctx: UsersRoutesContext) {
  return new Elysia({ prefix: '/api/v1/users' })
    .onError(({ error, set }) => {
      if (error instanceof AuthError) {
        set.status = error.status;
        return { error: error.message };
      }
      set.status = 500;
      return { error: error instanceof Error ? error.message : 'internal error' };
    })
    .get('/', ({ request }) => {
      const principal = ctx.getPrincipal(request);
      if (!principal) throw new AuthError(401, 'unauthenticated');
      const users = createUsersRepo(ctx.db)
        .listAll()
        .map((u) => ({ id: u.id, displayName: u.display_name }));
      return { users };
    });
}
