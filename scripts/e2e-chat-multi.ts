#!/usr/bin/env bun
/**
 * Cross-device convergence test for the chat conversation.
 *
 * Chat is per-user: two of a user's devices share one conversation. The
 * server's chat relay routes `chat:done` only to the originating WS, but the
 * user message is persisted before the relay step, so device B can see device
 * A's turn by loading the conversation.
 *
 * Shape: two real EalClient instances (the same module the SPA bundles)
 * speaking real WSS + HTTPS to a real api. No browser is needed — the unique
 * surface under test here is the wire convergence for one user across two
 * sessions, not the chat-panel UI (which lives in the polly browser tier and
 * is exercised end-to-end by scripts/e2e-chat.ts).
 *
 * What this script proves:
 *   1. Device A's `sendChat` over a real WSS connection causes the server to
 *      persist the message and echo `chat:user` back to A.
 *   2. The server returns `chat:error: No assistant is online — start eal
 *      agent on a paired device.` (deliberate — keeps the script free of
 *      Claude-subscription cost).
 *   3. Device B, on a fresh `listMessages()` over HTTPS, sees the row.
 *
 * If broadcast convergence is later added (server pushes the conversation
 * delta to all of the user's WS connections), extend this script so device B
 * waits on a `chat:user` event without calling `listMessages`.
 */
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootApi } from './lib/boot-api.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';
import {
  createEalClient,
  type ChatBrowserEvent,
  type EalClient,
} from '../packages/client/src/index.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/chat-multi');
const DB_PATH = resolve(ARTIFACTS, 'chat-multi.sqlite');
const FIXED_PORT = '4110';
const MARKER = `chat-multi-marker-${Date.now()}`;
const ECHO_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${what} after ${ms}ms`)), ms),
    ),
  ]);
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(ARTIFACTS, { recursive: true });
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  // Same displayName → same user. Two session tokens, one conversation.
  const sessionA = seedCliToken({ dbPath: DB_PATH, displayName: 'chat-pat', label: 'device-A' });
  const sessionB = seedCliToken({ dbPath: DB_PATH, displayName: 'chat-pat', label: 'device-B' });
  if (sessionA.userId !== sessionB.userId) {
    throw new Error(`expected one user across two sessions, got ${sessionA.userId} vs ${sessionB.userId}`);
  }

  const api = await bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost' });
  let clientA: EalClient | undefined;
  let clientB: EalClient | undefined;

  try {
    clientA = createEalClient(api.url, { token: sessionA.token });
    clientB = createEalClient(api.url, { token: sessionB.token });

    const eventsA: ChatBrowserEvent[] = [];
    clientA.subscribeChatEvents((e) => eventsA.push(e));
    await clientA.connect();
    await clientB.connect();

    // ─── 1. Device A sends a chat; collects user echo + no-agent error. ────
    const waitFor = new Promise<void>((res, rej) => {
      const timer = setTimeout(() => {
        const types = eventsA.map((e) => e.type).join(',');
        rej(new Error(`chat:user + chat:error not observed (saw: ${types})`));
      }, ECHO_TIMEOUT_MS);
      const unsubscribe = clientA!.subscribeChatEvents((e) => {
        const sawUser = eventsA.some(
          (x) => x.type === 'chat:user' && x.message.content === MARKER,
        );
        const sawError = eventsA.some((x) => x.type === 'chat:error');
        if (sawUser && sawError) {
          clearTimeout(timer);
          unsubscribe();
          res();
        }
        // Touch e so the linter doesn't complain about the unused param —
        // the actual reads run over the closure-captured eventsA above.
        void e;
      });
    });
    clientA.sendChat(MARKER);
    await withTimeout(waitFor, ECHO_TIMEOUT_MS, 'A chat:user + chat:error');
    console.log('e2e-chat-multi: A saw its echo and the no-agent error');

    // ─── 2. Device B reads the conversation; sees A's turn. ────────────────
    const messagesOnB = await clientB.listMessages();
    const found = messagesOnB.some(
      (m) => m.role === 'user' && m.content === MARKER,
    );
    if (!found) {
      throw new Error(
        `device B did not see device A's message. got ${messagesOnB.length} messages: ` +
          JSON.stringify(messagesOnB.slice(-3)),
      );
    }
    console.log("e2e-chat-multi: B sees A's persisted message via listMessages");

    console.log('e2e-chat-multi: OK');
    return 0;
  } catch (err) {
    console.error('e2e-chat-multi: FAIL', err);
    return 1;
  } finally {
    await clientA?.disconnect();
    await clientB?.disconnect();
    await api.kill();
  }
}

process.exit(await main());
