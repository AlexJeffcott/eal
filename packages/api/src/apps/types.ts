import type { AnyElysia } from 'elysia';
import type { DatabaseClient } from '../db/client.ts';
import type { GetPrincipalFn, Principal } from '../auth/principals.ts';
import type { TaskEvent } from '../handlers/tasks.http.ts';

/**
 * The minimum WebSocket surface apps need. Matches Elysia's per-callback ws
 * object: `id` is a stable string key (object identity is lost between
 * callbacks because Elysia wraps the raw socket each time), `send` accepts
 * text or binary frames.
 */
export interface WsLike {
  readonly id: string;
  send: (data: string | Uint8Array) => unknown;
}

/**
 * Connection-registry services exposed to apps so they can address peers,
 * subscribe to topics, and broadcast without reinventing the wheel. The
 * implementation is owned by server-factory (which holds the maps); apps
 * consume this interface via `ApiAppContext.ws`.
 */
export interface WsService {
  /** Send a JSON-serialised payload to a specific connection by wsId. */
  sendTo(wsId: string, payload: unknown): void;
  /** Send a binary frame to a specific connection by wsId. */
  sendBinaryTo(wsId: string, frame: Uint8Array): void;
  /** Attach this connection to a topic for fan-out broadcasts. */
  subscribe(ws: WsLike, topic: string): void;
  /** Detach this connection from a topic. */
  unsubscribe(ws: WsLike, topic: string): void;
  /** Send a JSON-serialised payload to every connection on a topic. */
  broadcast(topic: string, payload: unknown): void;
  /** Iterate every currently-connected authenticated principal. */
  connectedPrincipals(): Iterable<{ wsId: string; principal: Principal }>;
}

/**
 * What an app's WebSocket handler is built against. A subset of `ApiAppContext`
 * scoped to what makes sense in the WS hot path — no broadcastTask, no
 * getPrincipal (the principal is resolved by core's auth handshake and passed
 * to every callback explicitly).
 */
export interface WsAppContext {
  db: DatabaseClient;
  ws: WsService;
  /**
   * The environment this app reads its own config from — the trunk config for
   * family-phone, for example. Passed in rather than read from `process.env`
   * at the point of use, so a test can build an app whose configuration it
   * chose, exactly as it already chooses the WebAuthn RP. Production passes
   * `process.env`.
   */
  env: NodeJS.ProcessEnv;
}

/**
 * Per-app WebSocket message handler. Returned by `ApiApp.ws.handler` once,
 * at server start. Server-factory dispatches incoming text messages whose
 * `type` field begins with the app's `prefix:` to `onMessage`, and binary
 * frames whose leading byte equals the app's `binaryTag` to `onBinary`.
 *
 * `principal` is the user Principal bound at auth-handshake time, or null
 * for connections authenticated via the optional `authenticate` hook below
 * (those keep their identity in app-private state keyed by `ws.id`).
 *
 * `authenticate` is the app's optional alternative auth handshake. Core's
 * WS handler invokes it when an unauthenticated connection sends an
 * `{type: 'auth', ...}` message that does not carry a user Bearer `token`.
 * Return true to mark the connection authenticated (the app stores any
 * identity it needs in its own per-`ws.id` state); return false to decline
 * (core tries the next app, then rejects). May be async — WebCrypto
 * signature verification, DB lookups, etc.
 */
export interface WsMessageHandler {
  onMessage(ws: WsLike, msg: unknown, principal: Principal | null): void | Promise<void>;
  onBinary?(ws: WsLike, frame: Uint8Array, principal: Principal | null): void | Promise<void>;
  onClose?(ws: WsLike): void;
  authenticate?(ws: WsLike, msg: unknown): boolean | Promise<boolean>;
}

/**
 * What an API app's routes are built against. Supplied by server-factory,
 * which owns the db handle, the principal resolver, the WS broadcaster for
 * the legacy task topic, and the WsService for peer addressing.
 */
export interface ApiAppContext {
  db: DatabaseClient;
  getPrincipal: GetPrincipalFn;
  broadcastTask: (event: TaskEvent) => void;
  ws: WsService;
  /** See `WsAppContext.env`. */
  env: NodeJS.ProcessEnv;
}

/**
 * An API app — a slice of database schema plus a route plugin — composed into
 * the server by server-factory. Global concerns (auth, users, the chat relay)
 * are NOT apps: they are always present regardless of which apps are installed.
 */
export interface ApiApp {
  id: string;
  /** This app's own tables/indexes, appended after the global schema. */
  schema: string;
  routes: (ctx: ApiAppContext) => AnyElysia;
  /**
   * Optional opt-out from the global user-principal gate. When this predicate
   * returns true for an incoming (method, pathname), server-factory skips the
   * default 401 carve-out and trusts the app's own handler to enforce
   * authentication. Claim the narrowest possible prefix; the app's own tests
   * are responsible for proving unauthenticated requests receive a 401 from
   * its handler.
   */
  ownsAuthFor?: (method: string, pathname: string) => boolean;
  /**
   * Optional WebSocket message handler. The app claims text messages whose
   * `type` field begins with `<prefix>:` and (if `binaryTag` is set) binary
   * frames whose leading byte equals the tag. Connection lifecycle, auth, and
   * generic subscribe/unsubscribe stay in core. Binary tags `0x00`–`0x0F` are
   * reserved for core; apps pick from `0x10`–`0xFF`.
   */
  ws?: {
    prefix: string;
    binaryTag?: number;
    handler: (ctx: WsAppContext) => WsMessageHandler;
  };
}
