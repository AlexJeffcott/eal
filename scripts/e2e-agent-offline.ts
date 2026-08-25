#!/usr/bin/env bun
/**
 * Verification artefact for the assistant-availability signal — Plan 03,
 * `docs/plans/03-always-on-agent.md`.
 *
 * The relay routes chat to a connected `eal agent` process. With none, a sent
 * message comes back as an error the person only reads after typing it. The
 * browser can know first, so the composer says the assistant is offline
 * instead of taking a message nowhere.
 *
 * Real server, real WebSockets, no browsers and no Claude calls:
 *
 *   1. With no agent connected, `GET /api/v1/agent/status` reads false.
 *   2. A chat sent anyway comes back as `chat:error`, naming the fix.
 *   3. An agent connects → every browser is told `agent:status online:true`,
 *      and the HTTP read agrees.
 *   4. The agent disconnects → the browsers are told `online:false`.
 *
 * Step 3 is the one that matters for a phone: the panel must recover on its
 * own when the machine at home comes back, with no reload and no re-open.
 */
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pollUntil } from '@eal/shared';
import {
  createEalClient,
  type ChatBrowserEvent,
  type EalClient,
} from '../packages/client/src/index.ts';
import { bootApi } from './lib/boot-api.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/agent-offline');
const DB_PATH = resolve(ARTIFACTS, 'agent-offline.sqlite');
const FIXED_PORT = '4113';
const POLL = { intervalMs: 50, timeoutMs: 10_000 };

function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(ARTIFACTS, { recursive: true });
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  const session = seedCliToken({ dbPath: DB_PATH, displayName: 'agent-pat', label: 'browser' });
  const agentSession = seedCliToken({ dbPath: DB_PATH, displayName: 'agent-pat', label: 'worker' });

  const api = await bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost' });
  let browser: EalClient | undefined;
  let agent: EalClient | undefined;

  try {
    browser = createEalClient(api.url, { token: session.token });
    const statuses: boolean[] = [];
    browser.subscribeAgentStatus((online) => statuses.push(online));
    const chatEvents: ChatBrowserEvent[] = [];
    browser.subscribeChatEvents((e) => chatEvents.push(e));
    await browser.connect();

    // ─── 1. Nobody home ────────────────────────────────────────────────────
    assertEqual(await browser.getAgentStatus(), false, 'status with no agent');
    console.log('e2e-agent-offline: the api reports no assistant');

    // ─── 2. A message sent anyway is refused, and says how to fix it ────────
    browser.sendChat('are you there?');
    const failure = await pollUntil(
      () => chatEvents.find((e) => e.type === 'chat:error'),
      { ...POLL, label: 'a chat:error for the offline assistant' },
    );
    if (failure.type !== 'chat:error') throw new Error('expected chat:error');
    if (!failure.message.includes('eal agent')) {
      throw new Error(`the error does not name the fix: ${failure.message}`);
    }
    console.log('e2e-agent-offline: a chat sent with no assistant is refused, naming the fix');

    // ─── 3. The worker connects; the browser is told, unprompted ────────────
    agent = createEalClient(api.url, { token: agentSession.token });
    await agent.connectAsAgent({ onRequest: () => {}, onClose: () => {} });
    await pollUntil(() => statuses.at(-1) === true, {
      ...POLL,
      label: 'the browser to hear that an assistant is online',
    });
    assertEqual(await browser.getAgentStatus(), true, 'status with an agent connected');
    console.log('e2e-agent-offline: the browser hears the assistant arrive, with no reload');

    // ─── 4. And hears it leave ──────────────────────────────────────────────
    await agent.disconnect();
    await pollUntil(() => statuses.at(-1) === false, {
      ...POLL,
      label: 'the browser to hear that the assistant has gone',
    });
    assertEqual(await browser.getAgentStatus(), false, 'status after the agent left');
    console.log('e2e-agent-offline: the browser hears the assistant leave');

    console.log('e2e-agent-offline: OK');
    return 0;
  } catch (err) {
    console.error('e2e-agent-offline: FAIL', err);
    return 1;
  } finally {
    await browser?.disconnect();
    await agent?.disconnect();
    await api.kill();
  }
}

process.exit(await main());
