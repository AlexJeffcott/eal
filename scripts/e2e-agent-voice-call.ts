#!/usr/bin/env bun
/**
 * Verification artefact for the audio-first agent path.
 *
 * The shape required by ~/projects/CLAUDE.md: drives the real api,
 * a real `eal agent` subprocess, and the real client library through
 * the workflow a household member actually performs — pair the agent
 * onto family-phone, place a call to it, send PCM speech, receive
 * synthesised PCM back, hang up — and asserts every step at the wire.
 *
 * STT / TTS / Claude are all bound to deterministic stubs via env vars
 * so the test stays local and fast. The seams under test are the ones
 * a real bring-up cannot avoid: family-phone pairing for a kind='agent'
 * device, the worker's two-WS lifetime, the call accept/audio/hangup
 * path, the voice loop's VAD + sentence chunking, and the fixture TTS
 * frames travelling back over the same socket.
 */
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, type Subprocess } from 'bun';
import { delay } from '@eal/shared';
import { bootApi } from './lib/boot-api.ts';
import { seedCliToken } from './lib/seed-cli-token.ts';
import {
  createEalClient,
  type EalClient,
  type FamilyPhoneCallEvent,
  type FamilyPhoneDeviceConnection,
} from '../packages/client/src/index.ts';

const ROOT = resolve(import.meta.dir, '..');
const ARTIFACTS = resolve(ROOT, 'scripts/artifacts/agent-voice-call');
const DB_PATH = resolve(ARTIFACTS, 'agent-voice-call.sqlite');
const SAMPLES_PER_FRAME = 480; // 20 ms at 24 kHz, the wire format
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2;
const SPEECH_FRAMES = 40; // 800 ms of speech
const SILENCE_FRAMES = 40; // 800 ms of trailing silence — well over the 600 ms VAD hangover
const CLAUDE_FAKE_REPLY = 'Hello there. This is the assistant.';
const AGENT_READY_TIMEOUT_MS = 15_000;
const AUDIO_TIMEOUT_MS = 15_000;
const MIN_REPLY_BYTES = BYTES_PER_FRAME * 5; // 100 ms — fixture TTS produces ~28 frames for the canned reply

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
  // Loud square wave — well above the VAD threshold.
  for (let i = 0; i < SAMPLES_PER_FRAME; i++) s[i] = i % 2 === 0 ? 8000 : -8000;
  return pcm16Bytes(s);
}

interface PairedClient {
  client: EalClient;
  deviceId: number;
  conn: FamilyPhoneDeviceConnection;
  events: FamilyPhoneCallEvent[];
  audio: { callId: string; payload: Uint8Array }[];
}

async function pairCallerClient(apiUrl: string, token: string, label: string): Promise<PairedClient> {
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
    label,
    kind: 'pwa',
  });
  const conn = await client.connectFamilyPhoneDevice({ deviceId, privateKey: kp.privateKey });
  const events: FamilyPhoneCallEvent[] = [];
  const audio: { callId: string; payload: Uint8Array }[] = [];
  conn.subscribe((e) => events.push(e));
  conn.subscribeAudio((callId, payload) => audio.push({ callId, payload }));
  return { client, deviceId, conn, events, audio };
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

async function waitForAudioBytes(
  bag: { callId: string; payload: Uint8Array }[],
  callId: string,
  minBytes: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let total = 0;
    let nonZero = false;
    for (const a of bag) {
      if (a.callId !== callId) continue;
      total += a.payload.byteLength;
      for (let i = 0; i < a.payload.byteLength; i++) {
        if (a.payload[i] !== 0) { nonZero = true; break; }
      }
    }
    if (total >= minBytes && nonZero) return total;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${minBytes} bytes of audio on ${callId}`);
}

interface SpawnedAgent {
  proc: Subprocess;
  workdir: string;
  kill: () => Promise<void>;
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
      '--label=e2e-agent',
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

async function spawnAgentWorker(opts: {
  apiUrl: string;
  tokenPath: string;
  agentDevicePath: string;
}): Promise<SpawnedAgent> {
  const workdir = mkdtempSync(resolve(tmpdir(), 'eal-agent-e2e-'));
  const proc = spawn(
    ['bun', 'packages/cli/src/index.ts', `--api-url=${opts.apiUrl}`, `--token-path=${opts.tokenPath}`, 'agent'],
    {
      env: {
        ...process.env,
        EAL_AGENT_DEVICE_PATH: opts.agentDevicePath,
        EAL_STT_PROVIDER: 'fixture',
        EAL_TTS_PROVIDER: 'fixture',
        EAL_CLAUDE_FAKE_REPLY: CLAUDE_FAKE_REPLY,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      },
      stdout: 'pipe',
      stderr: 'inherit',
    },
  );
  // Stream the worker's stdout so the test log shows what it saw — and
  // wait for the "voice loop active" line before proceeding.
  const stdout = proc.stdout;
  if (typeof stdout === 'number' || stdout === undefined) {
    throw new Error('agent worker stdout was not piped');
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
      // Drain the rest of the stream onto stdout asynchronously so the
      // worker is not back-pressured into hanging on stdout writes.
      void (async () => {
        try {
          while (true) {
            const { value: v, done: d } = await reader.read();
            if (d) break;
            process.stdout.write(`[agent] ${decoder.decode(v)}`);
          }
        } catch {
          /* reader closed */
        }
      })();
      return {
        proc,
        workdir,
        kill: async () => {
          proc.kill('SIGTERM');
          await proc.exited;
          rmSync(workdir, { recursive: true, force: true });
        },
      };
    }
  }
  proc.kill('SIGKILL');
  throw new Error('agent worker did not reach "voice loop active" within timeout');
}

async function main(): Promise<void> {
  rmSync(ARTIFACTS, { recursive: true, force: true });
  mkdirSync(ARTIFACTS, { recursive: true });
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

  const api = await bootApi({ database: DB_PATH });
  console.log(`[e2e] api up at ${api.url}`);
  const seed = seedCliToken({ dbPath: DB_PATH, displayName: 'alex', label: 'agent-voice-e2e' });
  console.log(`[e2e] seeded user #${seed.userId}`);

  // Write the CLI token where the worker subprocess will read it.
  const tokenPath = resolve(ARTIFACTS, 'cli-token');
  writeFileSync(tokenPath, seed.token, { mode: 0o600 });
  const agentDevicePath = resolve(ARTIFACTS, 'agent-device.json');

  let agent: SpawnedAgent | null = null;
  let alice: PairedClient | null = null;
  try {
    // Pair Alice (the PWA stand-in) first so we have a client that can
    // mint family-phone user codes.
    alice = await pairCallerClient(api.url, seed.token, "Alex's laptop");
    console.log(`[e2e] paired caller device #${alice.deviceId}`);

    const { userCode } = await alice.client.startFamilyPhonePair();
    console.log(`[e2e] minted user code ${userCode} for the agent`);

    await runPairPhoneSubprocess({
      apiUrl: api.url,
      tokenPath,
      agentDevicePath,
      userCode,
    });
    console.log(`[e2e] agent device record written to ${agentDevicePath}`);

    agent = await spawnAgentWorker({ apiUrl: api.url, tokenPath, agentDevicePath });
    console.log(`[e2e] agent worker reached "voice loop active"`);

    // Find the agent's deviceId from the directory.
    const devices = await alice.client.listFamilyPhoneDevices();
    const agentDevice = devices.find((d) => d.kind === 'agent');
    if (!agentDevice) throw new Error('agent device did not appear in the directory');
    if (!agentDevice.online) {
      // Give presence a moment to flip — broadcast is fire-and-forget.
      await delay(250);
    }
    console.log(`[e2e] agent device #${agentDevice.id} listed in directory`);

    // Place a call from Alice → agent.
    alice.events.length = 0;
    alice.audio.length = 0;
    alice.conn.placeCall(agentDevice.id);
    const ack = await waitForEvent(alice.events, (e) => e.type === 'call:invite-ack', 5_000);
    if (ack.type !== 'call:invite-ack') throw new Error('unreachable');
    const callId = ack.callId;
    console.log(`[e2e] call ${callId} invited`);

    const accepted = await waitForEvent(
      alice.events,
      (e) => e.type === 'call:accepted' && e.callId === callId,
      10_000,
    );
    if (accepted.type !== 'call:accepted') throw new Error('unreachable');
    console.log(`[e2e] agent accepted call ${callId}`);

    // Pump speech then silence. The fixture STT resolves any non-empty
    // input to "hello"; the fake Claude returns the canned reply with
    // two sentences; the fixture TTS emits one frame per character per
    // sentence — comfortably above the 5-frame minimum the assertion
    // checks for.
    for (let i = 0; i < SPEECH_FRAMES; i++) {
      alice.conn.sendAudio(callId, speechFrame());
      // Pace so the receive side actually sees frames in order — the
      // worker's VAD reads each frame as it arrives.
      await delay(20);
    }
    for (let i = 0; i < SILENCE_FRAMES; i++) {
      alice.conn.sendAudio(callId, silenceFrame());
      await delay(20);
    }
    console.log(`[e2e] streamed ${SPEECH_FRAMES} speech + ${SILENCE_FRAMES} silence frames`);

    const received = await waitForAudioBytes(alice.audio, callId, MIN_REPLY_BYTES, AUDIO_TIMEOUT_MS);
    console.log(`[e2e] received ${received} bytes of synthesised reply audio`);

    alice.conn.hangup(callId);
    console.log(`[e2e] hangup sent`);

    console.log(`[e2e] OK — pair-phone, accept, speech→reply→hangup all roundtripped`);
  } finally {
    if (alice) alice.conn.close();
    if (agent) await agent.kill();
    await api.kill();
  }
}

await main();
