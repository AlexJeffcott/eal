import { Elysia, t } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import type { Principal } from '../auth/principals.ts';
import { createConversationsRepo } from '../db/repos/conversations.ts';
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
    })
    .get('/conversation-session', ({ request }) => {
      const principal = ctx.getPrincipal(request);
      if (!principal) throw new AuthError(401, 'unauthenticated');
      const repo = createConversationsRepo(ctx.db);
      return { sessionId: repo.getSessionId(principal.userId) };
    })
    .post(
      '/conversation-session',
      ({ request, body }) => {
        const principal = ctx.getPrincipal(request);
        if (!principal) throw new AuthError(401, 'unauthenticated');
        const repo = createConversationsRepo(ctx.db);
        repo.setSessionId(principal.userId, body.session_id);
        return { ok: true as const };
      },
      {
        body: t.Object({ session_id: t.String() }),
      },
    );
}
