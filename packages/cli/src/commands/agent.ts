import { createEalClient, type ChatAgentReply, type ChatAgentRequest } from '@eal/client';
import { delay } from '@eal/shared';
import { readToken, tokenPath } from '../lib/token-store.ts';
import { log, logError } from '../lib/process.ts';
import type { GlobalOptions } from '../types.ts';
import { createClaudeRunner, type ClaudeRunner } from './claude-runner.ts';

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
  const runClaude = await createClaudeRunner({
    apiUrl: global.apiUrl,
    tokenPath: tokenPath(global.tokenPathOverride),
  });

  log('eal agent: starting — the web app can now chat with the assistant.');
  log('  Press Ctrl-C to stop.');

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
