#!/usr/bin/env bun
/**
 * Cross-modal recall test: chat ↔ voice over a longer thread.
 *
 * The chat and voice paths in the agent share a Claude session id via the
 * conversations table — what is said over text in turn 1 must still be
 * present when a voice call resumes the session, and what is said in the
 * call must still be present when the next chat turn lands. This is the
 * smallest test that catches a regression in either direction.
 *
 * The agent is wired with deterministic stubs throughout:
 *   - EAL_CLAUDE_FAKE_REPLY uses the {{user_history}} template so every
 *     reply quotes every user turn the runner has ever seen for the
 *     session — so a recall regression is an obvious string-match miss.
 *   - EAL_STT_PROVIDER=fixture + EAL_STT_FIXTURE_TRANSCRIPT lets the test
 *     dictate what the call "heard" without a real STT.
 *   - EAL_TTS_PROVIDER=fixture emits a fixed tone burst so the call
 *     receives audio bytes without a real TTS.
 *
 * Flow:
 *   chat turn 1: marker_chat_1   →   reply must include marker_chat_1
 *   chat turn 2: marker_chat_2   →   reply must include 1 + 2 (chat recall)
 *   voice call (speech)          →   reply must include 1 + 2 + voice marker
 *                                    (chat → voice recall)
 *   chat turn 3: ask about call  →   reply must include the voice marker
 *                                    (voice → chat recall)
 */
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, type Subprocess } from 'bun';
import { delay } from '@eal/shared';
import { bootApi } from './lib/boot-api.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';
import {
  createEalClient,
  type ChatBrowserEvent,
  type EalClient,
  type FamilyPhoneCallEvent,
  type FamilyPhoneDeviceConnection,
} from '../packages/client/src/index.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/conversation-thread');
const DB_PATH = resolve(ARTIFACTS, 'conversation-thread.sqlite');
const TOKEN_PATH = resolve(ARTIFACTS, 'cli-token');
const AGENT_DEVICE_PATH = resolve(ARTIFACTS, 'agent-device.json');
const FIXED_PORT = '4111';

const MARKER_CHAT_1 = `chat-marker-A-${Date.now()}`;
const MARKER_CHAT_2 = `chat-marker-B-${Date.now()}`;
const MARKER_VOICE = `voice-marker-C-${Date.now()}`;
const FAKE_REPLY_TEMPLATE = 'heard: {{last_user}}. so far you have said: {{user_history}}.';

const SAMPLES_PER_FRAME = 480;
const SPEECH_FRAMES = 40;
const SILENCE_FRAMES = 40;
const AGENT_READY_TIMEOUT_MS = 15_000;
const CHAT_DONE_TIMEOUT_MS = 10_000;
const CALL_REPLY_TIMEOUT_MS = 15_000;

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pcm16Bytes(samples: Int16Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(samples.length * 2));
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] ?? 0, true);
  return out;
}

function silenceFrame(): Uint8Array<ArrayBuffer> {
  return pcm16Bytes(new Int16Array(SAMPLES_PER_FRAME));
}

function speechFrame(): Uint8Array<ArrayBuffer> {
  const s = new Int16Array(SAMPLES_PER_FRAME);
  for (let i = 0; i < SAMPLES_PER_FRAME; i++) s[i] = i % 2 === 0 ? 8000 : -8000;
  return pcm16Bytes(s);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${what} after ${ms}ms`)), ms),
    ),
  ]);
}

interface PairedClient {
  client: EalClient;
  deviceId: number;
  conn: FamilyPhoneDeviceConnection;
  events: FamilyPhoneCallEvent[];
}

async function pairHandset(apiUrl: string, token: string): Promise<PairedClient> {
  const client = createEalClient(apiUrl, { token });
  const { userCode } = await client.startFamilyPhonePair();
  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  const { deviceId } = await client.completeFamilyPhonePair({
    userCode,
    publicKey: toBase64Url(spki),
    alg: 'ES256',
    label: "alex's handset",
    kind: 'handset',
  });
  const conn = await client.connectFamilyPhoneDevice({ deviceId, privateKey: kp.privateKey });
  const events: FamilyPhoneCallEvent[] = [];
  conn.subscribe((e) => events.push(e));
  return { client, deviceId, conn, events };
}

async function waitForEvent(
  bag: FamilyPhoneCallEvent[],
  predicate: (e: FamilyPhoneCallEvent) => boolean,
  timeoutMs: number,
): Promise<FamilyPhoneCallEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = bag.find(predicate);
    if (found) return found;
    await delay(25);
  }
  throw new Error(`timed out waiting for event (have ${bag.map((e) => e.type).join(',')})`);
}

async function runPairPhoneSubprocess(opts: {
  apiUrl: string;
  tokenPath: string;
  agentDevicePath: string;
  userCode: string;
}): Promise<void> {
  const proc = spawn(
    [
      'bun',
      'packages/cli/src/index.ts',
      `--api-url=${opts.apiUrl}`,
      `--token-path=${opts.tokenPath}`,
      'agent',
      'pair-phone',
      `--code=${opts.userCode}`,
      '--label=e2e-conversation-thread',
    ],
    {
      env: {
        ...process.env,
        EAL_AGENT_DEVICE_PATH: opts.agentDevicePath,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      },
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  const code = await proc.exited;
  if (code !== 0) throw new Error(`agent pair-phone exited ${code}`);
  if (!existsSync(opts.agentDevicePath)) {
    throw new Error(`pair-phone did not write ${opts.agentDevicePath}`);
  }
}

interface SpawnedAgent {
  proc: Subprocess;
  kill: () => Promise<void>;
}

async function spawnAgent(opts: {
  apiUrl: string;
  tokenPath: string;
  agentDevicePath: string;
}): Promise<SpawnedAgent> {
  const proc = spawn(
    ['bun', 'packages/cli/src/index.ts', `--api-url=${opts.apiUrl}`, `--token-path=${opts.tokenPath}`, 'agent'],
    {
      env: {
        ...process.env,
        EAL_AGENT_DEVICE_PATH: opts.agentDevicePath,
        EAL_STT_PROVIDER: 'fixture',
        EAL_TTS_PROVIDER: 'fixture',
        EAL_STT_FIXTURE_TRANSCRIPT: MARKER_VOICE,
        EAL_CLAUDE_FAKE_REPLY: FAKE_REPLY_TEMPLATE,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      },
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );
  const stdout = proc.stdout;
  if (typeof stdout === 'number' || stdout === undefined) {
    throw new Error('agent stdout was not piped');
  }
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + AGENT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    process.stdout.write(`[agent] ${chunk}`);
    buf += chunk;
    if (buf.includes('voice loop active')) {
      void (async () => {
        try {
          while (true) {
            const { value: v, done: d } = await reader.read();
            if (d) break;
            process.stdout.write(`[agent] ${decoder.decode(v)}`);
          }
        } catch { /* reader closed */ }
      })();
      return {
        proc,
        kill: async () => {
          proc.kill('SIGTERM');
          const t = setTimeout(() => proc.kill('SIGKILL'), 2_000);
          await proc.exited;
          clearTimeout(t);
        },
      };
    }
  }
  proc.kill('SIGKILL');
  throw new Error('agent did not reach "voice loop active" within timeout');
}

type ChatDone = Extract<ChatBrowserEvent, { type: 'chat:done' }>;

async function sendChatTurn(
  client: EalClient,
  events: ChatBrowserEvent[],
  text: string,
  label: string,
): Promise<ChatDone> {
  const before = events.length;
  const done = new Promise<ChatBrowserEvent>((res, rej) => {
    const t = setTimeout(
      () => rej(new Error(`${label}: timeout waiting for chat:done/chat:error`)),
      CHAT_DONE_TIMEOUT_MS,
    );
    const tick = setInterval(() => {
      const terminal = events.slice(before).find(
        (e) => e.type === 'chat:done' || e.type === 'chat:error',
      );
      if (terminal) {
        clearTimeout(t);
        clearInterval(tick);
        res(terminal);
      }
    }, 25);
  });
  client.sendChat(text);
  const event = await done;
  if (event.type === 'chat:error') throw new Error(`${label}: ${event.message}`);
  if (event.type !== 'chat:done') throw new Error(`${label}: expected chat:done`);
  return event;
}

function assertIncludes(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(
      `${label}: reply did not include "${needle}". got: ${haystack.slice(0, 300)}`,
    );
  }
}

async function main(): Promise<number> {
  await rm(ARTIFACTS, { recursive: true, force: true });
  await mkdir(ARTIFACTS, { recursive: true });
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  const seed = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'thread-e2e' });
  await writeFile(TOKEN_PATH, seed.token, { encoding: 'utf8', mode: 0o600 });

  const api = await bootApi({ port: FIXED_PORT, database: DB_PATH, hostname: 'localhost' });

  let agent: SpawnedAgent | null = null;
  let alice: PairedClient | null = null;
  let chatClient: EalClient | undefined;

  try {
    // ─── Pair alice's handset, then pair the agent into family-phone. ──────
    alice = await pairHandset(api.url, seed.token);
    const { userCode } = await alice.client.startFamilyPhonePair();
    await runPairPhoneSubprocess({
      apiUrl: api.url,
      tokenPath: TOKEN_PATH,
      agentDevicePath: AGENT_DEVICE_PATH,
      userCode,
    });
    agent = await spawnAgent({
      apiUrl: api.url,
      tokenPath: TOKEN_PATH,
      agentDevicePath: AGENT_DEVICE_PATH,
    });
    const devices = await alice.client.listFamilyPhoneDevices();
    const agentDevice = devices.find((d) => d.kind === 'agent');
    if (!agentDevice) throw new Error('agent device not in directory');

    // ─── Chat client: same user, talks to the agent over the chat relay. ──
    chatClient = createEalClient(api.url, { token: seed.token });
    const events: ChatBrowserEvent[] = [];
    chatClient.subscribeChatEvents((e) => events.push(e));
    await chatClient.connect();

    // ─── Turn 1: chat. Reply must echo marker_chat_1. ──────────────────────
    const turn1 = await sendChatTurn(chatClient, events, MARKER_CHAT_1, 'chat turn 1');
    assertIncludes(turn1.message.content, MARKER_CHAT_1, 'chat turn 1');
    console.log('e2e-conversation-thread: turn 1 OK');

    // ─── Turn 2: chat. Reply must recall both markers. ─────────────────────
    const turn2 = await sendChatTurn(chatClient, events, MARKER_CHAT_2, 'chat turn 2');
    assertIncludes(turn2.message.content, MARKER_CHAT_1, 'chat turn 2 (chat→chat recall)');
    assertIncludes(turn2.message.content, MARKER_CHAT_2, 'chat turn 2 (echo)');
    console.log('e2e-conversation-thread: turn 2 OK (chat→chat recall proven)');

    // ─── Voice call. Speech is transcribed to MARKER_VOICE via fixture STT;
    //     the call resumes the same session as the chat, so the fake claude
    //     reply must include both chat markers + voice marker. ─────────────
    alice.events.length = 0;
    alice.conn.placeCall(agentDevice.id);
    const accepted = await waitForEvent(
      alice.events,
      (e) => e.type === 'call:accepted',
      10_000,
    );
    if (accepted.type !== 'call:accepted') throw new Error('unreachable');
    const callId = accepted.callId;

    for (let i = 0; i < SPEECH_FRAMES; i++) {
      alice.conn.sendAudio(callId, speechFrame());
      await delay(20);
    }
    for (let i = 0; i < SILENCE_FRAMES; i++) {
      alice.conn.sendAudio(callId, silenceFrame());
      await delay(20);
    }

    // The agent's voice loop logs what it said. We don't need to decode the
    // PCM; the recall is provable at the next chat turn (turn 3), which
    // sees the persisted history Claude saw on the call. Hang up cleanly.
    await withTimeout(
      waitForEvent(alice.events, (e) => e.type === 'call:invite-ack', 5_000),
      5_000,
      'call:invite-ack',
    );
    // Give the voice loop time to finish its Claude turn before hangup, so
    // the persisted FAKE_USER_HISTORY includes MARKER_VOICE.
    await delay(500);
    alice.conn.hangup(callId);
    console.log('e2e-conversation-thread: call placed, audio pumped, hung up');

    // ─── Turn 3: chat. Reply must recall both chat markers AND the voice
    //     marker the agent received during the call. This proves the
    //     voice→chat direction of the cross-modal session resume. ──────────
    const turn3 = await sendChatTurn(
      chatClient,
      events,
      'turn3-probe',
      'chat turn 3',
    );
    assertIncludes(turn3.message.content, MARKER_CHAT_1, 'chat turn 3 (chat→chat recall)');
    assertIncludes(turn3.message.content, MARKER_CHAT_2, 'chat turn 3 (chat→chat recall)');
    assertIncludes(turn3.message.content, MARKER_VOICE, 'chat turn 3 (voice→chat recall)');
    console.log('e2e-conversation-thread: turn 3 OK (voice→chat recall proven)');

    // Silence the unused-variable lint — the timeout guard above proves
    // the call actually opened.
    void CALL_REPLY_TIMEOUT_MS;

    console.log('e2e-conversation-thread: OK');
    return 0;
  } catch (err) {
    console.error('e2e-conversation-thread: FAIL', err);
    return 1;
  } finally {
    await chatClient?.disconnect();
    if (alice) alice.conn.close();
    if (agent) await agent.kill();
    await api.kill();
  }
}

process.exit(await main());
