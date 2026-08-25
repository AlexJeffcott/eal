import { Elysia, type AnyElysia } from 'elysia';
import { applySchema } from './db/schema.ts';
import type { DatabaseClient } from './db/client.ts';
import { authMiddleware } from './auth/middleware.ts';
import type { GetPrincipalFn, Principal } from './auth/principals.ts';
import { authHttpRoutes } from './handlers/auth.http.ts';
import { loadRegistrationConfig } from './auth/registration.ts';
import type { RpConfig } from './auth/webauthn.ts';
import { buildSpa } from './spa.ts';
import type { TaskEvent } from './handlers/tasks.http.ts';
import { messagesHttpRoutes } from './handlers/messages.http.ts';
import { loadPushVapidConfig, pushHttpRoutes } from './handlers/push.http.ts';
import { usersHttpRoutes } from './handlers/users.http.ts';
import { API_APPS } from './apps/registry.ts';
import type {
  ApiApp,
  ApiAppContext,
  WsAppContext,
  WsLike,
  WsMessageHandler,
  WsService,
} from './apps/types.ts';
import {
  getClaudeSessionCore,
  listRecentConversationCore,
  recordAssistantMessageCore,
  sendUserMessageCore,
  setClaudeSessionCore,
} from './handlers/messages.shared.ts';

/**
 * Production RP config, derived from the required EAL_ORIGIN env var. The RP ID
 * is the origin's hostname (`localhost`, `eal.fly.dev`, …) — exactly what
 * WebAuthn expects. There is no default: dev sets EAL_ORIGIN to the localhost
 * URL, production to the deployed origin. Tests never reach this — createTestApp
 * passes an explicit `rp`.
 */
function defaultRp(): RpConfig {
  const origin = process.env['EAL_ORIGIN'];
  if (origin === undefined || origin === '') {
    throw new Error(
      'EAL_API: EAL_ORIGIN is not set — cannot derive the WebAuthn RP. Set it to the public\n' +
        '  origin, e.g. https://localhost:4321 in dev or https://eal.fly.dev in production.',
    );
  }
  let rpID: string;
  try {
    rpID = new URL(origin).hostname;
  } catch {
    throw new Error(`EAL_API: EAL_ORIGIN="${origin}" is not a valid URL.`);
  }
  return { rpID, rpName: 'eal', origin };
}

type ServerEvent = TaskEvent;

/**
 * A WS connection is either a `browser` (the web app) or an `agent` (a running
 * `eal agent` process). The role, declared in the auth frame, decides chat
 * routing: browsers send `chat:send`, agents answer with `chat:chunk/done`.
 */
type WsRole = 'browser' | 'agent';

type ClientMessage =
  | { type: 'auth'; token?: string; role?: WsRole }
  | { type: 'subscribe'; topic: string }
  | { type: 'unsubscribe'; topic: string }
  | { type: 'chat:send'; text: string }
  | { type: 'chat:chunk'; requestId: string; delta: string }
  | { type: 'chat:done'; requestId: string; content: string; claudeSessionId: string }
  | { type: 'chat:error'; requestId: string; message: string };

/** A chat request in flight: which browser asked, whose conversation, which agent. */
interface PendingChat {
  browserWsId: string;
  conversationUserId: number;
  agentWsId: string;
}

export interface AppInternalOptions {
  rp?: RpConfig;
  /**
   * Optional pre-built SPA plugin. Production callers omit this and pay the
   * `Bun.build` cost at boot; tests pass a no-op `Elysia` to keep the test
   * runner free of the web workspace's transitive deps. The factory still
   * exposes `/public/*` paths via the rest of the auth/handlers tree.
   */
  spa?: Elysia;
  /**
   * Optional override of the installed app registry. Production uses
   * `API_APPS` from `apps/registry.ts`; tests pass a custom array to exercise
   * the apps surface (ownsAuthFor, route composition, WS dispatch) in
   * isolation.
   */
  apps?: readonly ApiApp[];
  /**
   * The environment apps read their own config from — see `ApiAppContext.env`.
   * Production omits this and gets `process.env`; tests pass what they mean to
   * configure, so a developer's `.env` cannot decide whether an app boots.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Auth-by-default gating. A request is exempt from the principal check when:
 *  - it targets `/public/*` — the auth ceremonies, health probe, SPA assets;
 *  - it is the `/ws` upgrade — a browser cannot send an Authorization header on
 *    the upgrade, so auth happens via the in-stream first-message handshake;
 *  - it is a GET outside `/api/*` — the SPA HTML shell, served for every client
 *    route so deep links and refreshes work. The shell carries no data.
 *
 * Every data and mutation route lives under `/api/*` and stays gated: a 401
 * without a valid token. Non-GET requests outside `/public/*` stay gated too,
 * so the carve-out never opens a write path.
 */
function isPublicPath(method: string, pathname: string): boolean {
  if (pathname === '/public' || pathname.startsWith('/public/')) return true;
  if (pathname === '/ws') return true;
  if (method === 'GET' && !pathname.startsWith('/api/')) return true;
  return false;
}

export async function createAppInternal(
  db: DatabaseClient,
  getPrincipalFn: GetPrincipalFn,
  options: AppInternalOptions = {},
) {
  applySchema(db);
  const spa = options.spa ?? (await buildSpa());
  const rp = options.rp ?? defaultRp();
  // Elysia wraps the raw socket per-callback, so keying by object identity
  // (WeakMap) loses entries between message calls. Key by the stable `ws.id`
  // string instead and track a snapshot of the live ws send-function per id.
  const subscribers = new Map<string, Map<string, WsLike>>(); // topic → (wsId → ws)
  const wsPrincipals = new Map<string, Principal>();
  const wsRoles = new Map<string, WsRole>();
  const connections = new Map<string, WsLike>(); // every authed ws, by id
  const agents = new Map<string, WsLike>(); // agent ws, by id — the chat workers
  const pendingChats = new Map<string, PendingChat>(); // requestId → routing
  /**
   * Connections authenticated by an app's WS authenticator rather than the
   * default Bearer-token path. The value is the app's id (registry id, e.g.
   * 'family-phone'); the app keeps any deeper identity (device id, etc.) in
   * its own per-`ws.id` state.
   */
  const wsAppAuth = new Map<string, string>();

  function broadcast(topic: string, event: ServerEvent): void {
    const targets = subscribers.get(topic);
    if (!targets) return;
    const message = JSON.stringify(event);
    for (const ws of targets.values()) ws.send(message);
  }
  function broadcastTask(event: TaskEvent): void {
    broadcast('tasks', event);
  }
  function subscribe(ws: WsLike, topic: string): void {
    const map = subscribers.get(topic) ?? new Map<string, WsLike>();
    map.set(ws.id, ws);
    subscribers.set(topic, map);
  }
  function unsubscribe(ws: WsLike, topic: string): void {
    const map = subscribers.get(topic);
    if (!map) return;
    map.delete(ws.id);
    if (map.size === 0) subscribers.delete(topic);
  }
  function sendTo(wsId: string, payload: object): void {
    const target = connections.get(wsId);
    if (target) target.send(JSON.stringify(payload));
  }
  /**
   * Tell every browser whether an assistant is reachable.
   *
   * Chat is routed to a connected `eal agent` process; with none, a request
   * comes back as an error the person only sees after typing and sending. The
   * panel can say so first. Sent to browser connections directly rather than
   * over a topic — there is one bit of state and no subscription to manage.
   */
  function broadcastAgentStatus(): void {
    const message = JSON.stringify({ type: 'agent:status', online: agents.size > 0 });
    for (const [id, ws] of connections) {
      if (wsRoles.get(id) === 'browser') ws.send(message);
    }
  }
  function handleClose(ws: WsLike): void {
    for (const [topic, map] of subscribers) {
      map.delete(ws.id);
      if (map.size === 0) subscribers.delete(topic);
    }
    wsPrincipals.delete(ws.id);
    wsRoles.delete(ws.id);
    wsAppAuth.delete(ws.id);
    connections.delete(ws.id);
    if (agents.delete(ws.id)) {
      // An agent dropped — fail any chat routed to it so the browser that's
      // waiting on a reply gets a definite answer instead of hanging forever.
      for (const [requestId, pending] of pendingChats) {
        if (pending.agentWsId === ws.id) {
          sendTo(pending.browserWsId, {
            type: 'chat:error',
            message: 'The assistant disconnected before replying. Try again.',
          });
          pendingChats.delete(requestId);
        }
      }
      if (agents.size === 0) broadcastAgentStatus();
    }
    for (const handler of appWsHandlers.values()) {
      handler.onClose?.(ws);
    }
  }

  // Apps and the auth gate both read their config from this environment.
  // Production omits `options.env` and gets `process.env`; tests pass what they
  // mean to configure, so a developer's `.env` never decides a test's outcome.
  const appEnv = options.env ?? process.env;

  const auth = authHttpRoutes({ db, rp, registration: loadRegistrationConfig(appEnv) });
  const messages = messagesHttpRoutes({ db, getPrincipal: getPrincipalFn });
  const users = usersHttpRoutes({ db, getPrincipal: getPrincipalFn });
  // VAPID config is read at factory time; tests construct the factory
  // without env vars set and get a null config (push endpoints 503).
  // The actual web-push initialisation happens once in server.ts so
  // a hot-restarted factory doesn't redundantly re-bind it.
  const vapid = loadPushVapidConfig();
  const push = pushHttpRoutes({ vapid });

  // App routes are composed from the registry; global concerns (auth, users,
  // the chat relay) are mounted directly — they are not apps.
  const apps = options.apps ?? API_APPS;

  // The WsService exposes the connection-registry to apps without leaking
  // the underlying Maps. Implementation reuses the same maps used internally.
  const wsService: WsService = {
    sendTo(wsId, payload) {
      const target = connections.get(wsId);
      if (target) target.send(JSON.stringify(payload));
    },
    sendBinaryTo(wsId, frame) {
      const target = connections.get(wsId);
      if (!target) return;
      // Elysia's ws.send JSON-stringifies a plain Uint8Array (only Buffer
      // is treated as binary; see node_modules/elysia/dist/ws/index.js).
      // Wrap the frame in a Buffer view so cross-endpoint sends from app
      // routes (e.g. the Twilio media WS forwarding audio to a handset)
      // hit the wire as a binary frame, not a JSON envelope.
      const asBuffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
      target.send(asBuffer);
    },
    subscribe(ws, topic) {
      subscribe(ws, topic);
    },
    unsubscribe(ws, topic) {
      unsubscribe(ws, topic);
    },
    broadcast(topic, payload) {
      const targets = subscribers.get(topic);
      if (!targets) return;
      const message = JSON.stringify(payload);
      for (const ws of targets.values()) ws.send(message);
    },
    *connectedPrincipals() {
      for (const [wsId, principal] of wsPrincipals) {
        yield { wsId, principal };
      }
    },
  };

  // Per-app WS handlers, instantiated once at boot. The prefix and binaryTag
  // maps drive runtime dispatch in the message callback below. Duplicate
  // claims fail fast at boot rather than dropping messages silently.
  const appWsHandlers = new Map<string, WsMessageHandler>();
  const prefixToApp = new Map<string, string>();
  const binaryTagToApp = new Map<number, string>();
  for (const app of apps) {
    if (!app.ws) continue;
    if (prefixToApp.has(app.ws.prefix)) {
      throw new Error(
        `server-factory: WS prefix '${app.ws.prefix}' claimed by both ` +
          `'${prefixToApp.get(app.ws.prefix)}' and '${app.id}'`,
      );
    }
    if (app.ws.binaryTag !== undefined) {
      if (app.ws.binaryTag < 0x10 || app.ws.binaryTag > 0xff) {
        throw new Error(
          `server-factory: app '${app.id}' binaryTag ${app.ws.binaryTag} ` +
            `outside the app range 0x10-0xFF (0x00-0x0F reserved for core)`,
        );
      }
      if (binaryTagToApp.has(app.ws.binaryTag)) {
        throw new Error(
          `server-factory: WS binary tag 0x${app.ws.binaryTag.toString(16)} ` +
            `claimed by both '${binaryTagToApp.get(app.ws.binaryTag)}' and '${app.id}'`,
        );
      }
      binaryTagToApp.set(app.ws.binaryTag, app.id);
    }
    prefixToApp.set(app.ws.prefix, app.id);
    const wsCtx: WsAppContext = { db, ws: wsService, env: appEnv };
    appWsHandlers.set(app.id, app.ws.handler(wsCtx));
  }

  const apiCtx: ApiAppContext = {
    db,
    getPrincipal: getPrincipalFn,
    broadcastTask,
    ws: wsService,
    env: appEnv,
  };
  let builder: AnyElysia = new Elysia()
    .decorate('db', db)
    .use(authMiddleware(getPrincipalFn))
    .onBeforeHandle(({ request, set }) => {
      const url = new URL(request.url);
      if (isPublicPath(request.method, url.pathname)) return;
      if (apps.some((app) => app.ownsAuthFor?.(request.method, url.pathname))) return;
      const principal = getPrincipalFn(request);
      if (!principal) {
        set.status = 401;
        return { error: 'unauthenticated' };
      }
      return;
    })
    .use(spa)
    .use(auth.public)
    .use(auth.authed)
    .use(messages)
    .use(users)
    .use(push)
    // The same bit the WS announces, for a page that has just loaded and has
    // heard no announcement yet. Lives here rather than in the agent app: the
    // registry of connected agents belongs to this factory, not to a DB table.
    .get('/api/v1/agent/status', () => ({ online: agents.size > 0 }));
  for (const app of apps) {
    builder = builder.use(app.routes(apiCtx));
  }

  return builder
    .get('/public/health', () => ({ status: 'ok' as const }))
    .ws('/ws', {
      close(ws: WsLike) {
        handleClose(ws);
      },
      async message(ws: WsLike, raw: unknown) {
        // Binary frames are dispatched by their leading byte. Auth is required
        // (no binary frames in the pre-auth state) and the tag must match a
        // registered app; anything else is dropped silently to avoid leaking
        // framing details to attackers.
        const binary = toBinary(raw);
        if (binary !== null) {
          const principal = wsPrincipals.get(ws.id) ?? null;
          const appAuthed = wsAppAuth.has(ws.id);
          if ((!principal && !appAuthed) || binary.length === 0) return;
          const leadingByte = binary[0];
          if (leadingByte === undefined) return;
          const appId = binaryTagToApp.get(leadingByte);
          if (!appId) return;
          await appWsHandlers.get(appId)?.onBinary?.(ws, binary, principal);
          return;
        }

        let msg: ClientMessage;
        try {
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
          msg = JSON.parse(text);
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
          return;
        }
        // Captured before the switch narrows `msg` to `never` on the
        // exhaustive built-in paths — used by the per-app dispatch below to
        // route unknown message types to the app that claims their prefix.
        const msgType: string = msg.type;

        // First-message auth handshake. Until either the core user-Bearer
        // path or an app-supplied authenticator has bound the connection,
        // only { type: 'auth', ... } is accepted; everything else is rejected.
        const principal = wsPrincipals.get(ws.id) ?? null;

        if (msg.type === 'auth') {
          // User/bearer path: msg carries a non-empty `token`. Existing role
          // semantics ('browser' vs 'agent') are preserved.
          if (typeof msg.token === 'string' && msg.token.length > 0) {
            const candidate = getPrincipalFn(new Request('https://localhost/ws', {
              headers: { authorization: `Bearer ${msg.token}` },
            }));
            if (!candidate) {
              ws.send(JSON.stringify({ type: 'error', code: 'unauthenticated', message: 'invalid token' }));
              return;
            }
            const role: WsRole = msg.role === 'agent' ? 'agent' : 'browser';
            wsPrincipals.set(ws.id, candidate);
            wsRoles.set(ws.id, role);
            connections.set(ws.id, ws);
            if (role === 'agent') {
              const wasOffline = agents.size === 0;
              agents.set(ws.id, ws);
              if (wasOffline) broadcastAgentStatus();
            }
            ws.send(JSON.stringify({
              type: 'auth:ok',
              role,
              user: { id: candidate.userId, displayName: candidate.displayName },
            }));
            return;
          }
          // No bearer token — fall through to app-supplied authenticators
          // in registry order. The first that returns true claims the
          // connection; the app maintains its own per-`ws.id` identity.
          for (const [appId, handler] of appWsHandlers) {
            if (!handler.authenticate) continue;
            const ok = await handler.authenticate(ws, msg);
            if (ok) {
              wsAppAuth.set(ws.id, appId);
              connections.set(ws.id, ws);
              ws.send(JSON.stringify({ type: 'auth:ok', via: appId }));
              return;
            }
          }
          ws.send(JSON.stringify({
            type: 'error',
            code: 'unauthenticated',
            message: 'no auth handler matched',
          }));
          return;
        }

        const appAuthed = wsAppAuth.has(ws.id);
        if (!principal && !appAuthed) {
          ws.send(JSON.stringify({ type: 'error', code: 'unauthenticated', message: 'authenticate first' }));
          return;
        }

        switch (msg.type) {
          case 'subscribe': {
            subscribe(ws, msg.topic);
            ws.send(JSON.stringify({ type: 'subscribed', topic: msg.topic }));
            return;
          }
          case 'unsubscribe': {
            unsubscribe(ws, msg.topic);
            return;
          }
          case 'chat:send': {
            // Persist the human's message, echo the canonical row, then route
            // the conversation to a connected agent for Claude to answer.
            // Chat is user-only; app-authed connections silently ignore.
            if (!principal) return;
            let userMessage;
            try {
              userMessage = sendUserMessageCore(db, { text: msg.text }, principal);
            } catch (err) {
              ws.send(JSON.stringify({
                type: 'chat:error',
                message: err instanceof Error ? err.message : 'could not send message',
              }));
              return;
            }
            ws.send(JSON.stringify({ type: 'chat:user', message: userMessage }));

            const agent = agents.values().next().value;
            if (!agent) {
              ws.send(JSON.stringify({
                type: 'chat:error',
                message: 'No assistant is online — start `eal agent` on a paired device.',
              }));
              return;
            }
            const conversation = listRecentConversationCore(db, principal);
            const claudeSessionId = getClaudeSessionCore(db, principal);
            const requestId = crypto.randomUUID();
            pendingChats.set(requestId, {
              browserWsId: ws.id,
              conversationUserId: principal.userId,
              agentWsId: agent.id,
            });
            agent.send(JSON.stringify({
              type: 'chat:request',
              requestId,
              claudeSessionId,
              conversation,
            }));
            return;
          }
          case 'chat:chunk': {
            // Streamed reply text — only agents produce these.
            if (wsRoles.get(ws.id) !== 'agent') return;
            const pending = pendingChats.get(msg.requestId);
            if (!pending) return;
            sendTo(pending.browserWsId, { type: 'chat:chunk', delta: msg.delta });
            return;
          }
          case 'chat:done': {
            if (wsRoles.get(ws.id) !== 'agent') return;
            const pending = pendingChats.get(msg.requestId);
            if (!pending) return;
            pendingChats.delete(msg.requestId);
            const assistantMessage = recordAssistantMessageCore(db, {
              content: msg.content,
              conversationUserId: pending.conversationUserId,
            });
            // Persist the Claude session the agent used so the next turn in
            // this conversation resumes it instead of seeding cold.
            setClaudeSessionCore(db, pending.conversationUserId, msg.claudeSessionId);
            sendTo(pending.browserWsId, { type: 'chat:done', message: assistantMessage });
            return;
          }
          case 'chat:error': {
            if (wsRoles.get(ws.id) !== 'agent') return;
            const pending = pendingChats.get(msg.requestId);
            if (!pending) return;
            pendingChats.delete(msg.requestId);
            sendTo(pending.browserWsId, { type: 'chat:error', message: msg.message });
            return;
          }
          default: {
            // Per-app prefix dispatch keyed by the type's prefix
            // (e.g. 'call:invite' → app with prefix 'call'). If no app
            // claims it, surface an explicit error rather than dropping.
            const colon = msgType.indexOf(':');
            if (colon > 0) {
              const prefix = msgType.slice(0, colon);
              const appId = prefixToApp.get(prefix);
              if (appId) {
                await appWsHandlers.get(appId)?.onMessage(ws, msg, principal);
                return;
              }
            }
            ws.send(JSON.stringify({
              type: 'error',
              code: 'unknown-message-type',
              message: `no handler for message type '${msgType}'`,
            }));
            return;
          }
        }
      },
    });
}

/**
 * Coerce an Elysia/Bun WS payload to a Uint8Array when it's a binary frame,
 * or null when it's text/JSON. Bun delivers binary as Uint8Array (Buffer
 * extends it); other runtimes may use ArrayBuffer directly. Strings are not
 * binary even if they happen to look like one.
 */
export function toBinary(raw: unknown): Uint8Array | null {
  if (typeof raw === 'string') return null;
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return null;
}

export type App = Awaited<ReturnType<typeof createAppInternal>>;
