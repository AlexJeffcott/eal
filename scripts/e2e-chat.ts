#!/usr/bin/env bun
/**
 * End-to-end chat-relay test — the Phase 2 verification artefact.
 *
 * The shape required by ~/projects/CLAUDE.md ("Green checks do not prove
 * features work"): it drives the REAL workflow a household member touches.
 * A browser-side EalClient sends a chat over WSS → the server relay persists
 * it and routes it to a running `eal agent` → the agent runs the real `claude`
 * CLI with the non-destructive eal MCP tools → the streamed reply comes back.
 *
 * REQUIRES the `claude` CLI installed and logged in — this is the "reuse your
 * Claude Code login" path the user chose. It makes real, subscription-billed
 * Claude calls (two turns). There is no mock anywhere in this script.
 *
 * Steps:
 *  1. Boot the api against a fresh sqlite db; seed a session token.
 *  2. Start `eal agent`; wait for it to connect to the relay.
 *  3. Connect a browser-side EalClient.
 *  4. Turn 1: ask it to create a task. Assert the echo, streamed chunks, a
 *     non-empty reply, and that the task was actually created via the tool.
 *  5. Turn 2: a follow-up that needs turn-1 context. Assert the reply recalls
 *     it, and — the key check — that the Claude session id is UNCHANGED
 *     between turns, proving turn 2 resumed turn 1's session, not re-seeded.
 *  6. Assert persistence: the conversation has both turns' messages.
 */
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn, type Subprocess } from 'bun';
import { Database } from 'bun:sqlite';
import {
  createEalClient,
  type ChatBrowserEvent,
  type EalClient,
  type Message,
} from '../packages/client/src/index.ts';
import { bootApi } from './lib/boot-api.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';
import { waitFor } from './lib/e2e-config.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/chat');
const DB_PATH = resolve(ARTIFACTS, 'chat.sqlite');
const TOKEN_PATH = resolve(ARTIFACTS, 'agent-token');
const FIXED_PORT = '4108';
const MARKER = `e2e-chat-marker-${Date.now()}`;
const CLAUDE_REPLY_TIMEOUT_MS = 150_000;

type ChatDone = Extract<ChatBrowserEvent, { type: 'chat:done' }>;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${what} after ${ms}ms`)), ms),
    ),
  ]);
}

/** Pipe a child's stdout to our own and resolve once `marker` appears. */
function pipeUntil(stream: ReadableStream<Uint8Array>, marker: string): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  let resolved = false;
  let resolveFn: () => void = () => {};
  const ready = new Promise<void>((res) => { resolveFn = res; });
  void (async () => {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        buf += chunk;
        process.stdout.write(chunk);
        if (!resolved && buf.includes(marker)) {
          resolved = true;
          resolveFn();
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
  return ready;
}

/** Read the persisted Claude session id for a conversation, straight from sqlite. */
function readSessionId(userId: number): string | null {
  const db = new Database(DB_PATH, { readonly: true });
  interface Row { claude_session_id: string | null }
  const row = db
    .prepare<Row, [number]>('SELECT claude_session_id FROM conversations WHERE user_id = ?')
    .get(userId);
  db.close();
  return row?.claude_session_id ?? null;
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(ARTIFACTS, { recursive: true });
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  // ─── 1. Seed a token + boot the api ────────────────────────────────────────
  const seed = seedCliToken({ dbPath: DB_PATH, displayName: 'chat-tester', label: 'chat-e2e' });
  await writeFile(TOKEN_PATH, seed.token, 'utf8');
  const api = await bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost' });

  let agent: Subprocess | undefined;
  let browser: EalClient | undefined;

  try {
    // ─── 2. Start `eal agent`, wait for it to connect to the relay ───────────
    agent = spawn(['bun', 'packages/cli/src/index.ts', 'agent'], {
      cwd: ROOT,
      env: {
        ...process.env,
        EAL_API_URL: api.url,
        EAL_TOKEN_PATH: TOKEN_PATH,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      },
      stdout: 'pipe',
      stderr: 'inherit',
    });
    if (!agent.stdout || typeof agent.stdout === 'number') {
      throw new Error('e2e-chat: agent stdout was not piped');
    }
    await withTimeout(
      pipeUntil(agent.stdout, 'connected and waiting'),
      20_000,
      'eal agent to connect',
    );

    // ─── 3. Browser-side client: subscribe, connect ──────────────────────────
    browser = createEalClient(api.url, { token: seed.token });
    const client = browser;
    const events: ChatBrowserEvent[] = [];
    let resolveTurn: (e: ChatBrowserEvent) => void = () => {};
    client.subscribeChatEvents((event: ChatBrowserEvent) => {
      events.push(event);
      if (event.type === 'chat:done' || event.type === 'chat:error') resolveTurn(event);
    });
    await client.connect();

    /** Send one chat turn and await its terminal event, with per-turn checks. */
    async function turn(label: string, text: string): Promise<ChatDone> {
      const before = events.length;
      const done = new Promise<ChatBrowserEvent>((res) => { resolveTurn = res; });
      console.log(`e2e-chat: [${label}] ${text}`);
      client.sendChat(text);
      const result = await withTimeout(done, CLAUDE_REPLY_TIMEOUT_MS, `${label} reply`);
      if (result.type === 'chat:error') throw new Error(`${label}: assistant error: ${result.message}`);
      if (result.type !== 'chat:done') throw new Error(`${label}: expected chat:done, got ${result.type}`);
      if (result.message.content.trim().length === 0) throw new Error(`${label}: empty reply`);
      const chunks = events.slice(before).filter((e) => e.type === 'chat:chunk').length;
      console.log(`e2e-chat: [${label}] reply (${chunks} chunk(s)): ${result.message.content.slice(0, 200)}`);
      return result;
    }

    // ─── 4. Turn 1: create a task ────────────────────────────────────────────
    await turn('turn 1', `Create a task with exactly this title: ${MARKER}`);
    if (!events.some((e) => e.type === 'chat:user')) {
      throw new Error('no chat:user echo was relayed back');
    }

    const matches = await waitFor(
      async () => {
        const list = await client.listTasks({ q: MARKER });
        return list.length > 0 ? list : null;
      },
      { timeoutMs: 10_000, description: `a task matching "${MARKER}"` },
    );
    if (matches === null || matches[0] === undefined) {
      throw new Error('the assistant did not create the task');
    }
    console.log(`e2e-chat: assistant created task #${matches[0].id}: ${matches[0].title}`);

    const sessionAfterTurn1 = readSessionId(seed.userId);
    if (sessionAfterTurn1 === null) {
      throw new Error('no Claude session id was persisted after turn 1');
    }

    // ─── 5. Turn 2: a follow-up that only works with turn-1 context ──────────
    const turn2 = await turn(
      'turn 2',
      'What was the exact title of the task you just created for me? Reply with only the title.',
    );
    if (!turn2.message.content.includes(MARKER)) {
      throw new Error(`turn 2 did not recall turn-1 context — reply: ${turn2.message.content.slice(0, 200)}`);
    }

    const sessionAfterTurn2 = readSessionId(seed.userId);
    if (sessionAfterTurn2 !== sessionAfterTurn1) {
      throw new Error(
        `Claude session changed between turns (${sessionAfterTurn1} → ${sessionAfterTurn2}) — ` +
          'turn 2 re-seeded instead of resuming',
      );
    }
    console.log(`e2e-chat: turn 2 resumed turn 1's Claude session (${sessionAfterTurn1})`);

    // ─── 6. Persistence: both turns are in the conversation ─────────────────
    const conversation = await client.listMessages();
    const userTurns = conversation.filter((m: Message) => m.role === 'user').length;
    const assistantTurns = conversation.filter((m: Message) => m.role === 'assistant').length;
    if (userTurns < 2 || assistantTurns < 2) {
      throw new Error(`expected ≥2 user and ≥2 assistant messages, got ${userTurns}/${assistantTurns}`);
    }

    console.log('e2e-chat: OK');
    return 0;
  } catch (err) {
    console.error('e2e-chat: FAIL', err);
    return 1;
  } finally {
    await browser?.disconnect();
    if (agent) {
      agent.kill('SIGTERM');
      const handle = setTimeout(() => agent?.kill('SIGKILL'), 2_000);
      await agent.exited;
      clearTimeout(handle);
    }
    await api.kill();
  }
}

process.exit(await main());
