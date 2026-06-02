import { Elysia, t } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import { createUsersRepo, type UserRow } from '../db/repos/users.ts';
import { AuthError } from './auth.shared.ts';

export interface UsersRoutesContext {
  db: DatabaseClient;
  getPrincipal: (request: Request) => Principal | null;
}

function toWire(u: UserRow): { id: number; displayName: string; inIvrMenu: boolean } {
  return { id: u.id, displayName: u.display_name, inIvrMenu: u.in_ivr_menu === 1 };
}

/**
 * Two routes:
 *   - GET  /api/v1/users        — household roster for the assignee picker
 *     and the admin's IVR-menu management. Carries the in_ivr_menu flag.
 *   - PATCH /api/v1/users/:id   — flip the in_ivr_menu opt-in (Phase 7D).
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
      const users = createUsersRepo(ctx.db).listAll().map(toWire);
      return { users };
    })
    .patch(
      '/:id',
      ({ body, params, request, set }) => {
        const principal = ctx.getPrincipal(request);
        if (!principal) throw new AuthError(401, 'unauthenticated');
        const id = Number(params.id);
        if (!Number.isInteger(id) || id <= 0) {
          set.status = 400;
          return { error: 'user id must be a positive integer' };
        }
        const updated = createUsersRepo(ctx.db).setInIvrMenu(id, body.inIvrMenu);
        if (!updated) {
          set.status = 404;
          return { error: `user ${id} not found` };
        }
        return { user: toWire(updated) };
      },
      { body: t.Object({ inIvrMenu: t.Boolean() }) },
    );
}
