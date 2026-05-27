import {
  createEalClient,
  type ChatAgentReply,
  type ChatAgentRequest,
  type EalClient,
  type FamilyPhoneDeviceConnection,
} from '@eal/client';
import { delay } from '@eal/shared';
import { readToken, tokenPath } from '../lib/token-store.ts';
import { readAgentDevice, type AgentDeviceRecord } from '../lib/agent-device-store.ts';
import { importAgentPrivateKey } from '../lib/agent-key-import.ts';
import { log, logError } from '../lib/process.ts';
import type { GlobalOptions } from '../types.ts';
import { createClaudeRunner, type ClaudeRunner } from './claude-runner.ts';
import { DEFAULT_REJECT_REASON, installAgentPhoneHandler } from './agent-phone-loop.ts';
import { createAgentOutboundDialer } from './agent-outbound-dialer.ts';
import { startAgentScheduler } from './agent-scheduler.ts';
import { createVoiceLoop } from './voice-loop.ts';
import type { SttProvider, TtsProvider } from './voice-providers.ts';
import { createFixtureStt, createFixtureTts } from './voice-providers-fixture.ts';
import { createWhisperHostedStt, createWhisperLocalStt } from './stt-whisper.ts';
import { createPiperTts, createSayTts } from './tts-piper.ts';

/**
 * `eal agent` — the long-running assistant worker.
 *
 * It connects to the server's WS relay as an `agent`, and for every chat
 * request a household member sends from the web app it runs Claude (with a
 * bounded, non-destructive eal tool set), streams the reply back as chunks,
 * and finishes with the complete text. The server persists the conversation
 * and relays everything to the originating browser.
 */

/** Reconnect backoff: starts here, doubles per consecutive failure, capped at
 *  RECONNECT_MAX_MS. Reset to the base once a connection is established, so a
 *  brief blip recovers fast while a sustained outage is not hammered. */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export interface ChatRequestDeps {
  runClaude: ClaudeRunner;
  /** Send a reply frame upstream. Must not throw — swallow a dropped socket. */
  sendReply: (reply: ChatAgentReply) => void;
  log: (line: string) => void;
}

/**
 * Answer one chat request. The streaming core: drives the runner, relays each
 * non-empty delta as a `chat:chunk`, then sends `chat:done` with the full text.
 * Any failure becomes a `chat:error` so the browser never hangs.
 */
export async function handleChatRequest(
  request: ChatAgentRequest,
  deps: ChatRequestDeps,
): Promise<void> {
  try {
    const result = await deps.runClaude(
      { conversation: request.conversation, sessionId: request.claudeSessionId },
      (delta) => {
        if (delta.length > 0) {
          deps.sendReply({ type: 'chat:chunk', requestId: request.requestId, delta });
        }
      },
    );
    deps.sendReply({
      type: 'chat:done',
      requestId: request.requestId,
      content: result.content,
      claudeSessionId: result.sessionId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'the assistant could not answer';
    deps.log(`eal agent: request ${request.requestId} failed: ${message}`);
    deps.sendReply({ type: 'chat:error', requestId: request.requestId, message });
  }
}

/**
 * Dispatcher: `eal agent [subcommand]`.
 *
 * With no subcommand it runs the long-running worker loop. With
 * `pair-phone` it routes to the family-phone device pairing flow so the
 * worker can later identify itself on the call network.
 */
export async function agentCommand(global: GlobalOptions): Promise<number> {
  const first = global.commandArgs[0];
  if (first === 'pair-phone') {
    const { agentPairPhoneCommand } = await import('./agent-pair-phone.ts');
    return agentPairPhoneCommand({ ...global, commandArgs: global.commandArgs.slice(1) });
  }
  if (first !== undefined && first.startsWith('-') === false) {
    logError(`eal agent: unknown subcommand "${first}"`);
    logError('  expected: pair-phone (or no subcommand to run the worker)');
    return 1;
  }
  return runAgentWorker(global);
}

async function runAgentWorker(global: GlobalOptions): Promise<number> {
  const token = readToken(global.tokenPathOverride);
  if (token === null) {
    logError('eal agent: this device is not paired — run `eal auth pair --label=<name>` first.');
    return 1;
  }

  const client = createEalClient(global.apiUrl, { token });
  const runClaude = await selectClaudeRunner(global);

  log('eal agent: starting — the web app can now chat with the assistant.');
  log('  Press Ctrl-C to stop.');

  // Family-phone identity is optional. If the device record is present
  // the worker also appears on the call network; without it the chat
  // path still works and we just point the operator at the pair command.
  const phoneRecord = readAgentDevice();
  if (phoneRecord === null) {
    log('eal agent: voice disabled — run `eal agent pair-phone --code=<user-code>` to register on family-phone.');
    log('eal agent: proactivity disabled — register on family-phone first.');
  } else {
    const providers = selectVoiceProviders();
    if (providers === null) {
      log(
        'eal agent: family-phone identity present but voice providers not selected — set EAL_STT_PROVIDER=fixture and EAL_TTS_PROVIDER=fixture to enable the fixture voice loop. Incoming calls will be rejected.',
      );
    }
    void startPhoneLoop(client, phoneRecord, runClaude, providers, (connection) => {
      // Family-phone is up — install the outbound dialer and start the
      // proactivity scheduler against this same connection. Both keep
      // running for the worker's lifetime; the connection itself
      // manages WS reconnects internally.
      const dialer = createAgentOutboundDialer({ client, connection, log });
      startAgentScheduler({
        client,
        now: () => new Date(),
        log,
        dialer,
      });
      log('eal agent: proactivity scheduler running.');
    });
  }

  // A dropped socket triggers `onClose`, which resolves the per-attempt
  // `closed` promise; the loop then backs off and reconnects. Never returns.
  let backoffMs = RECONNECT_BASE_MS;
  for (;;) {
    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    try {
      await client.connectAsAgent({
        onRequest: (request) => {
          log(`eal agent: chat request (${request.conversation.length} messages in context)`);
          void handleChatRequest(request, {
            runClaude,
            sendReply: (reply) => {
              try {
                client.sendChatReply(reply);
              } catch {
                // Socket dropped mid-reply; the relay fails the request itself.
              }
            },
            log,
          });
        },
        onClose: () => resolveClosed(),
      });
      // The connection is established — reset the backoff so a later brief
      // drop reconnects promptly.
      backoffMs = RECONNECT_BASE_MS;
      log('eal agent: connected and waiting for chat requests.');
      await closed;
      logError('eal agent: connection closed — reconnecting…');
    } catch (err) {
      logError(`eal agent: connect failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Backoff before reconnecting: here the wait itself is the behaviour.
    // Doubles on each consecutive failure (capped) and is reset above once a
    // connection succeeds.
    await delay(backoffMs);
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
  }
}

/**
 * Open the agent's family-phone device socket and install the
 * placeholder call handler. The underlying connection manages its own
 * reconnect-on-close (see `connectFamilyPhoneDevice` in eal-client.ts),
 * so this function only needs to retry the *initial* open — once a
 * first connect succeeds, drops are handled internally.
 */
async function startPhoneLoop(
  client: EalClient,
  record: AgentDeviceRecord,
  runClaude: ClaudeRunner,
  providers: { stt: SttProvider; tts: TtsProvider } | null,
  onConnected?: (connection: FamilyPhoneDeviceConnection) => void,
): Promise<void> {
  let privateKey: CryptoKey;
  try {
    privateKey = await importAgentPrivateKey(record.privateKeyPkcs8B64);
  } catch (err) {
    logError(
      `eal agent: family-phone key import failed: ${err instanceof Error ? err.message : String(err)} — voice disabled until next restart`,
    );
    return;
  }

  let backoffMs = RECONNECT_BASE_MS;
  for (;;) {
    try {
      const connection = await client.connectFamilyPhoneDevice({
        deviceId: record.deviceId,
        privateKey,
      });
      const voiceLoopFactory = providers
        ? (callId: string, sendAudio: (payload: Uint8Array) => void) =>
            createVoiceLoop({
              runClaude,
              stt: providers.stt,
              tts: providers.tts,
              sendAudio,
              log: (line) => log(`[call ${callId}] ${line}`),
            })
        : undefined;
      installAgentPhoneHandler(connection, {
        log,
        rejectReason: DEFAULT_REJECT_REASON,
        ...(voiceLoopFactory ? { voiceLoopFactory } : {}),
      });
      log(
        providers
          ? `eal agent: family-phone device ${record.deviceId} ("${record.label}") online — voice loop active.`
          : `eal agent: family-phone device ${record.deviceId} ("${record.label}") online — incoming calls will be politely rejected.`,
      );
      onConnected?.(connection);
      return;
    } catch (err) {
      logError(
        `eal agent: family-phone connect failed: ${err instanceof Error ? err.message : String(err)} — retry in ${backoffMs}ms`,
      );
    }
    await delay(backoffMs);
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
  }
}

/**
 * The real ClaudeRunner spawns the `claude` CLI; that is unfit for an
 * automated end-to-end where the test must not depend on a working
 * Anthropic key or Claude Code install. Setting EAL_CLAUDE_FAKE_REPLY
 * substitutes a deterministic runner that emits the given string as a
 * single delta — enough to exercise the sentence-chunking and TTS path
 * the voice loop relies on. Production never sets this.
 */
async function selectClaudeRunner(global: GlobalOptions): Promise<ClaudeRunner> {
  const fakeReply = process.env['EAL_CLAUDE_FAKE_REPLY'];
  if (typeof fakeReply === 'string') {
    log('eal agent: EAL_CLAUDE_FAKE_REPLY set — using deterministic stub runner for tests');
    return async (_input, emit) => {
      emit(fakeReply);
      return { content: fakeReply, sessionId: 'fake-session' };
    };
  }
  return createClaudeRunner({
    apiUrl: global.apiUrl,
    tokenPath: tokenPath(global.tokenPathOverride),
  });
}

function selectVoiceProviders(): { stt: SttProvider; tts: TtsProvider } | null {
  const sttName = process.env['EAL_STT_PROVIDER'];
  const ttsName = process.env['EAL_TTS_PROVIDER'];
  if (sttName === undefined || ttsName === undefined) return null;
  const stt = pickStt(sttName);
  const tts = pickTts(ttsName);
  if (stt === null || tts === null) return null;
  return { stt, tts };
}

function pickStt(name: string): SttProvider | null {
  if (name === 'fixture') return createFixtureStt();
  if (name === 'whisper-local') {
    const binPath = process.env['EAL_WHISPER_BIN'];
    const modelPath = process.env['EAL_WHISPER_MODEL'];
    if (!binPath || !modelPath) {
      logError('eal agent: EAL_STT_PROVIDER=whisper-local requires EAL_WHISPER_BIN and EAL_WHISPER_MODEL');
      return null;
    }
    return createWhisperLocalStt({ binPath, modelPath });
  }
  if (name === 'whisper-hosted') {
    const apiKey = process.env['EAL_OPENAI_API_KEY'];
    if (!apiKey) {
      logError('eal agent: EAL_STT_PROVIDER=whisper-hosted requires EAL_OPENAI_API_KEY');
      return null;
    }
    return createWhisperHostedStt({ apiKey });
  }
  logError(`eal agent: unknown EAL_STT_PROVIDER="${name}" (expected: fixture | whisper-local | whisper-hosted)`);
  return null;
}

function pickTts(name: string): TtsProvider | null {
  if (name === 'fixture') return createFixtureTts();
  if (name === 'say') return createSayTts();
  if (name === 'piper') {
    const binPath = process.env['EAL_PIPER_BIN'];
    const modelPath = process.env['EAL_PIPER_MODEL'];
    if (!binPath || !modelPath) {
      logError('eal agent: EAL_TTS_PROVIDER=piper requires EAL_PIPER_BIN and EAL_PIPER_MODEL');
      return null;
    }
    const rateEnv = process.env['EAL_PIPER_RATE'];
    const modelSampleRate = rateEnv ? Number(rateEnv) : undefined;
    if (rateEnv !== undefined && (modelSampleRate === undefined || !Number.isFinite(modelSampleRate) || modelSampleRate <= 0)) {
      logError(`eal agent: EAL_PIPER_RATE="${rateEnv}" is not a positive number`);
      return null;
    }
    return createPiperTts(
      modelSampleRate !== undefined
        ? { binPath, modelPath, modelSampleRate }
        : { binPath, modelPath },
    );
  }
  logError(`eal agent: unknown EAL_TTS_PROVIDER="${name}" (expected: fixture | piper | say)`);
  return null;
}
