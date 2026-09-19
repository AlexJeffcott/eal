import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { delay, pollUntil } from '@eal/shared';
import { createEalClient, extractServerError, type EalClient } from './eal-client.ts';

/**
 * Pure-function coverage for the http error-envelope unwrap. The web UI's
 * friendly mapping depends on this function returning the SERVER message
 * (e.g. "webauthn: credential not found") rather than the wrapping JSON.
 * If this contract drifts, the friendly mappers in actions/registry.ts
 * will silently stop matching.
 */
describe('extractServerError', () => {
  describe('happy path: { "error": "..." } envelope', () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['{"error":"oh no"}', 'oh no'],
      ['{"error":"webauthn: credential not found"}', 'webauthn: credential not found'],
      // Extra fields must not poison the unwrap.
      ['{"error":"x","code":500,"path":"/y"}', 'x'],
      // Whitespace inside the JSON is fine.
      ['{ "error" : "spaced" }', 'spaced'],
      // The inner string is returned verbatim — no trimming, no JSON re-escape.
      ['{"error":"  padded  "}', '  padded  '],
      ['{"error":""}', ''],
    ];
    for (const [body, expected] of cases) {
      test(`${JSON.stringify(body)} → ${JSON.stringify(expected)}`, () => {
        expect(extractServerError(body)).toBe(expected);
      });
    }
  });

  describe('fallback: returns raw body when not a recognised envelope', () => {
    const cases: ReadonlyArray<[label: string, body: string]> = [
      ['no `error` key', '{"code":500}'],
      ['`error` is a number', '{"error":42}'],
      ['`error` is null', '{"error":null}'],
      ['`error` is a boolean', '{"error":true}'],
      ['`error` is an object', '{"error":{"nested":"x"}}'],
      ['`error` is an array', '{"error":["x"]}'],
      ['top-level null', 'null'],
      ['top-level string', '"just a string"'],
      ['top-level number', '42'],
      ['top-level array', '["error","x"]'],
      ['invalid JSON', 'not json {'],
      ['empty body', ''],
      ['whitespace only', '   '],
      ['html error page', '<html><body>500</body></html>'],
    ];
    for (const [label, body] of cases) {
      test(`${label}: returns the raw body unchanged`, () => {
        expect(extractServerError(body)).toBe(body);
      });
    }
  });

  test('multi-line server error is preserved verbatim', () => {
    const body = '{"error":"line one\\nline two"}';
    expect(extractServerError(body)).toBe('line one\nline two');
  });

  test('unicode in the server error round-trips', () => {
    const body = '{"error":"ünïcødé ✓ 中文"}';
    expect(extractServerError(body)).toBe('ünïcødé ✓ 中文');
  });
});

/**
 * The browser WebSocket's reconnect loop.
 *
 * A phone suspends its tab, the socket closes, and before this loop existed
 * nothing reopened it: the app kept rendering the last state it had heard and
 * every broadcast sent meanwhile was lost. These tests drive a fake socket, so
 * they assert the loop itself — that a drop reopens, that the topic
 * subscription is re-declared on the new socket, and that a deliberate
 * `disconnect()` stops the retries.
 */
class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  /** Every socket the client has opened, in order. */
  static instances: FakeWebSocket[] = [];

  readyState: number = FakeWebSocket.OPEN;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Array<{ handler: (e: unknown) => void; once: boolean }>>();

  /** How many of the next sockets never open — no network, or no server. */
  static unreachableOpens = 0;
  /** Whether the next `auth` frame is refused. */
  static rejectAuth = false;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    // The client attaches its 'open' listener synchronously after `new`, so a
    // microtask is late enough for it to be heard and early enough to keep the
    // test free of timers.
    if (FakeWebSocket.unreachableOpens > 0) {
      FakeWebSocket.unreachableOpens -= 1;
      this.readyState = FakeWebSocket.CLOSED;
      queueMicrotask(() => this.dispatch('error', {}));
      return;
    }
    queueMicrotask(() => this.dispatch('open', {}));
  }

  addEventListener(type: string, handler: (e: unknown) => void, opts?: { once?: boolean }): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push({ handler, once: opts?.once === true });
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, handler: (e: unknown) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    this.listeners.set(type, bucket.filter((entry) => entry.handler !== handler));
  }

  send(raw: string): void {
    this.sent.push(raw);
    const parsed: { type?: string } = JSON.parse(raw);
    if (parsed.type === 'auth') {
      const reply = FakeWebSocket.rejectAuth
        ? { type: 'error', code: 'unauthenticated', message: 'invalid token' }
        : { type: 'auth:ok' };
      queueMicrotask(() => this.dispatch('message', { data: JSON.stringify(reply) }));
    }
  }

  /** The server (or the network) dropping the connection. */
  dropped(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', {});
  }

  close(): void {
    this.dropped();
  }

  private dispatch(type: string, event: unknown): void {
    const bucket = this.listeners.get(type) ?? [];
    this.listeners.set(type, bucket.filter((entry) => !entry.once));
    for (const entry of bucket) entry.handler(event);
  }
}

/** Frames of a given type sent on one socket. */
function framesOfType(ws: FakeWebSocket, type: string): string[] {
  return ws.sent.filter((raw) => {
    const parsed: { type?: string } = JSON.parse(raw);
    return parsed.type === type;
  });
}

describe('browser WS reconnect', () => {
  const realWebSocket = Reflect.get(globalThis, 'WebSocket');

  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.unreachableOpens = 0;
    FakeWebSocket.rejectAuth = false;
    Reflect.set(globalThis, 'WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    Reflect.set(globalThis, 'WebSocket', realWebSocket);
  });

  function newClient(): EalClient {
    return createEalClient('https://localhost:4321', { token: 'test-token' });
  }

  test('connect authenticates and subscribes to the tasks topic', async () => {
    const client = newClient();
    await client.connect();

    expect(FakeWebSocket.instances.length).toBe(1);
    const first = FakeWebSocket.instances[0]!;
    expect(framesOfType(first, 'auth').length).toBe(1);
    expect(framesOfType(first, 'subscribe').length).toBe(1);
    expect(client.connectionState()).toBe('connected');
  });

  test('a dropped socket is reopened, re-authenticated and re-subscribed', async () => {
    const client = newClient();
    await client.connect();
    const first = FakeWebSocket.instances[0]!;

    first.dropped();
    // The state must say so immediately — the whole defect was the app
    // reading "connected" while the socket was gone.
    expect(client.connectionState()).toBe('reconnecting');

    const second = await pollUntil(() => FakeWebSocket.instances[1], {
      intervalMs: 25,
      timeoutMs: 5_000,
      label: 'a replacement socket',
    });
    await pollUntil(() => client.connectionState() === 'connected', {
      intervalMs: 25,
      timeoutMs: 5_000,
      label: 'the reconnect to complete',
    });
    // A new socket starts deaf: the server holds subscriptions per connection,
    // so the topic has to be declared again or no broadcast ever arrives.
    expect(framesOfType(second, 'auth').length).toBe(1);
    expect(framesOfType(second, 'subscribe').length).toBe(1);
  });

  test('state transitions are published to subscribers, without repeats', async () => {
    const client = newClient();
    const seen: string[] = [];
    client.subscribeConnectionState((state) => seen.push(state));

    await client.connect();
    FakeWebSocket.instances[0]!.dropped();
    await pollUntil(() => client.connectionState() === 'connected', {
      intervalMs: 25,
      timeoutMs: 5_000,
      label: 'the reconnect to complete',
    });

    expect(seen).toEqual(['connecting', 'connected', 'reconnecting', 'connected']);
  });

  test('disconnect stops the loop — a deliberate close is not a drop', async () => {
    const client = newClient();
    await client.connect();
    await client.disconnect();

    expect(client.connectionState()).toBe('idle');
    // Give the loop every chance to fire: the first backoff is 500ms.
    await delay(700);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  test('reconnectNow does not wait out the backoff', async () => {
    const client = newClient();
    await client.connect();
    FakeWebSocket.instances[0]!.dropped();

    client.reconnectNow();
    // No polling: the attempt starts synchronously, so the socket exists
    // before the first backoff delay could possibly have elapsed.
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  test('reconnectNow is a no-op while the socket is healthy', async () => {
    const client = newClient();
    await client.connect();

    client.reconnectNow();
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  test('a first connect that cannot reach the server joins the retry loop', async () => {
    // The offline cold boot: the app opens from the cached shell with no
    // network. The client must come back by itself when the network does.
    FakeWebSocket.unreachableOpens = 1;
    const client = newClient();
    const seen: string[] = [];
    client.subscribeConnectionState((state) => seen.push(state));

    await client.connect();
    expect(client.connectionState()).toBe('reconnecting');

    await pollUntil(() => client.connectionState() === 'connected', {
      timeoutMs: 3_000,
      intervalMs: 20,
      label: 'the retry to connect',
    });
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(framesOfType(FakeWebSocket.instances[1]!, 'subscribe').length).toBe(1);
    expect(seen).toEqual(['connecting', 'reconnecting', 'connected']);
    await client.disconnect();
  });

  test('a first connect with a refused token does not retry', async () => {
    FakeWebSocket.rejectAuth = true;
    const client = newClient();

    await expect(client.connect()).rejects.toThrow('ws auth rejected: invalid token');
    expect(client.connectionState()).toBe('error');
    // Give the loop every chance to fire: the first backoff is 500ms.
    await delay(700);
    expect(FakeWebSocket.instances.length).toBe(1);
  });
});

/**
 * The saved user. `GET /auth/me` needs the network, so an offline cold boot
 * has a token it cannot check. The client keeps the last user the server
 * confirmed beside the token, and returns it only when no response arrived.
 */
describe('getCurrentUser with no network', () => {
  const realFetch = globalThis.fetch;
  const realStorage = Reflect.get(globalThis, 'localStorage');
  let stored: Map<string, string>;

  function answerWith(respond: () => Promise<Response>): void {
    Reflect.set(globalThis, 'fetch', respond);
  }
  const unreachable = (): Promise<Response> => Promise.reject(new TypeError('fetch failed'));
  const me = (): Promise<Response> =>
    Promise.resolve(Response.json({ userId: 7, displayName: 'alex' }));

  beforeEach(() => {
    stored = new Map();
    Reflect.set(globalThis, 'localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    });
  });

  afterEach(() => {
    Reflect.set(globalThis, 'fetch', realFetch);
    Reflect.set(globalThis, 'localStorage', realStorage);
  });

  function newClient(): EalClient {
    return createEalClient('https://localhost:4321', { token: 'test-token' });
  }

  test('a confirmed user is returned again when the server cannot be reached', async () => {
    const client = newClient();
    answerWith(me);
    expect(await client.getCurrentUser()).toEqual({ userId: 7, displayName: 'alex' });

    answerWith(unreachable);
    expect(await newClient().getCurrentUser()).toEqual({ userId: 7, displayName: 'alex' });
  });

  test('with no saved user, an unreachable server still throws', async () => {
    answerWith(unreachable);
    await expect(newClient().getCurrentUser()).rejects.toThrow('fetch failed');
  });

  test('a 401 clears the saved user, so a later outage opens signed out', async () => {
    answerWith(me);
    await newClient().getCurrentUser();
    answerWith(() => Promise.resolve(new Response('', { status: 401 })));
    expect(await newClient().getCurrentUser()).toBeNull();

    answerWith(unreachable);
    await expect(newClient().getCurrentUser()).rejects.toThrow('fetch failed');
  });

  test('a failing status is not an outage: the saved user is not used', async () => {
    answerWith(me);
    await newClient().getCurrentUser();
    answerWith(() => Promise.resolve(new Response('', { status: 500 })));
    await expect(newClient().getCurrentUser()).rejects.toThrow('GET /api/v1/auth/me failed: 500');
  });

  test('a saved user is not returned without a token', async () => {
    answerWith(me);
    await newClient().getCurrentUser();
    answerWith(unreachable);
    const signedOut = createEalClient('https://localhost:4321');
    await expect(signedOut.getCurrentUser()).rejects.toThrow('fetch failed');
  });

  test('sign-out removes the saved user', async () => {
    answerWith(me);
    const client = newClient();
    await client.getCurrentUser();
    expect(stored.has('eal-user')).toBe(true);
    answerWith(() => Promise.resolve(new Response('{}')));
    await client.signOut();
    expect(stored.has('eal-user')).toBe(false);
  });

  test('a malformed saved user is ignored', async () => {
    stored.set('eal-user', '{"userId":"7"}');
    answerWith(unreachable);
    await expect(newClient().getCurrentUser()).rejects.toThrow('fetch failed');
  });
});
