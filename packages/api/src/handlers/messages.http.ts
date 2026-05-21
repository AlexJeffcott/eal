import { Elysia } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import { AuthError } from './auth.shared.ts';
import { clearConversationCore, listConversationCore } from './messages.shared.ts';

export interface MessagesRoutesContext {
  db: DatabaseClient;
  getPrincipal: (request: Request) => Principal | null;
}

/**
 * Two routes: the SPA loads the conversation when the chat panel mounts, and
 * "Clear" resets it. New messages flow over the WS relay, not here.
 */
export function messagesHttpRoutes(ctx: MessagesRoutesContext) {
  return new Elysia({ prefix: '/api/v1/messages' })
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
      return { messages: listConversationCore(ctx.db, principal) };
    })
    .post('/clear', ({ request }) => {
      const principal = ctx.getPrincipal(request);
      if (!principal) throw new AuthError(401, 'unauthenticated');
      clearConversationCore(ctx.db, principal);
      return { ok: true as const };
    });
}
