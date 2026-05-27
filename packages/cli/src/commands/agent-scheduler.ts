import type {
  AgentAction,
  AgentRule,
  EalClient,
  UpsertAgentRuleInput,
} from '@eal/client';
import { assertNever, delay } from '@eal/shared';
import type { AgentOutboundDialer } from './agent-outbound-dialer.ts';
import type { ClaudeRunner } from './claude-runner.ts';
import type { TtsProvider } from './voice-providers.ts';

/**
 * The agent worker's scheduler tick. Every TICK_MS the worker pulls
 * the household's proactivity rules from the api and, for any whose
 * `nextFireAt <= now` (and cooldown has expired), asks the agent app
 * to create a place-call action. The action handler claims the phone
 * lock and inserts a pending audit row; the worker's outbound-dial
 * path picks up the action and drives the actual `call:invite` over
 * its family-phone WS in a follow-up commit.
 *
 * The tick also advances the rule's `nextFireAt`:
 *   - rules with a non-null `intervalSec` bump forward by that many
 *     seconds (one-shot rules with a null interval stay put — they
 *     fire once and then sit idle, kept enabled in the table so the
 *     admin still sees the row);
 *   - the bump happens after the action is created, so a worker that
 *     crashes between action-create and rule-bump re-fires the same
 *     rule next tick — and the server-side cooldown is the safety
 *     net for "ring at most once per hour."
 */

export const DEFAULT_TICK_MS = 30_000;

export interface AgentSchedulerDeps {
  client: EalClient;
  /** Current time, injected for testability. */
  now: () => Date;
  log: (line: string) => void;
  /**
   * Optional outbound dialer. When present, every tick sweeps the
   * server-side audit log for pending actions without a `callId` and
   * dials each one. Without a dialer the tick only creates actions —
   * useful for the unit-test layer that exercises rule firing in
   * isolation.
   */
  dialer?: AgentOutboundDialer;
  /**
   * How many recent actions to scan per tick. The pending-action sweep
   * only needs to look at the head of the log because actions move to
   * a terminal result on completion; the default of 50 is generous.
   */
  pendingActionScanLimit?: number;
  /**
   * Voice synthesis seam for `voice_message` rules. Without it the
   * tick still recognises the rule but parks it on `notImplemented`.
   */
  tts?: TtsProvider;
  /**
   * The agent's family-phone device id, stamped as `from_device_id`
   * on every posted voicemail. Required to take the voice_message
   * branch alongside `tts`.
   */
  agentDeviceId?: number;
  /**
   * Optional Claude runner. Used by `voice_message` rules that supply
   * a `systemPrompt` rather than a literal `body` — the worker asks
   * Claude to generate the spoken text before synthesis.
   */
  claudeRunner?: ClaudeRunner;
}

export interface TickResult {
  /** Rules that the tick decided were due. */
  due: AgentRule[];
  /** Rules whose action handler returned 409 (agent busy on another call). */
  busySkipped: number[];
  /** Rules whose `nextFireAt` was advanced this tick. */
  advanced: number[];
  /** Rule ids whose `kind` is not yet implemented. */
  notImplemented: number[];
  /** Voicemail rule ids whose synth-and-post completed this tick. */
  voiceMessagesSent: number[];
  /** Errors swallowed during the tick, paired with the rule id that caused them. */
  errors: Array<{ ruleId: number; message: string }>;
  /** Action ids successfully dialed by the outbound sweep this tick. */
  dialed: number[];
  /** Action ids the dialer surfaced an error on. */
  dialErrors: Array<{ actionId: number; message: string }>;
}

export async function tickOnce(deps: AgentSchedulerDeps): Promise<TickResult> {
  const result: TickResult = {
    due: [],
    busySkipped: [],
    advanced: [],
    notImplemented: [],
    voiceMessagesSent: [],
    errors: [],
    dialed: [],
    dialErrors: [],
  };
  const now = deps.now();
  const nowIso = now.toISOString();

  let rules: AgentRule[];
  try {
    rules = await deps.client.listAgentRules();
  } catch (err) {
    deps.log(`scheduler: listAgentRules failed: ${describeError(err)}`);
    return result;
  }

  for (const rule of rules) {
    if (!isDue(rule, now)) continue;
    result.due.push(rule);

    try {
      switch (rule.kind) {
        case 'place_call': {
          const action = await deps.client.createAgentPlaceCallAction({
            targetDeviceId: rule.targetDeviceId,
            trigger: 'scheduled',
            ruleId: rule.id,
          });
          if (action === null) {
            // The agent is already on a call. Leave `nextFireAt` alone
            // so the rule re-fires next tick once the lock clears.
            deps.log(`scheduler: rule #${rule.id} skipped — agent is busy`);
            result.busySkipped.push(rule.id);
            break;
          }
          await advanceRule(deps.client, rule, now);
          deps.log(
            `scheduler: rule #${rule.id} fired — action #${action.id} pending (target ${rule.targetDeviceId})`,
          );
          result.advanced.push(rule.id);
          break;
        }
        case 'voice_message': {
          // Voice messages need a TTS provider and the agent's own
          // family-phone device id (to stamp `from_device_id` on the
          // stored row). When either is missing the rule is parked
          // on `notImplemented` so the admin sees an honest log line
          // and the rule fires again once the worker is configured.
          if (deps.tts === undefined || deps.agentDeviceId === undefined) {
            deps.log(
              `scheduler: rule #${rule.id} kind=voice_message — no tts or agent device, left untouched`,
            );
            result.notImplemented.push(rule.id);
            break;
          }
          const text = await resolveVoiceMessageText(rule, deps);
          if (text === null) {
            deps.log(`scheduler: rule #${rule.id} produced no spoken text; left untouched`);
            result.notImplemented.push(rule.id);
            break;
          }
          const audio = await synthesise(deps.tts, text);
          await deps.client.postVoiceMessage({
            toDeviceId: rule.targetDeviceId,
            fromDeviceId: deps.agentDeviceId,
            body: text,
            audio,
            sampleRate: VOICE_MESSAGE_SAMPLE_RATE,
            channels: 1,
          });
          await advanceRule(deps.client, rule, now);
          deps.log(
            `scheduler: rule #${rule.id} sent voicemail (target ${rule.targetDeviceId}, ${audio.byteLength} bytes)`,
          );
          result.voiceMessagesSent.push(rule.id);
          break;
        }
        default:
          assertNever(rule.kind);
      }
    } catch (err) {
      const message = describeError(err);
      deps.log(`scheduler: rule #${rule.id} errored: ${message}`);
      result.errors.push({ ruleId: rule.id, message });
    }
  }

  // Now sweep the audit log for pending actions that have not yet
  // been dialed. The rule pass above just inserted some of them; the
  // MCP `place_call` tool inserts others on demand. Either way the
  // worker is the only thing that can drive the actual call:invite.
  void nowIso;
  if (deps.dialer !== undefined) {
    await sweepPendingDials(deps, deps.dialer, result);
  }
  return result;
}

async function sweepPendingDials(
  deps: AgentSchedulerDeps,
  dialer: AgentOutboundDialer,
  result: TickResult,
): Promise<void> {
  const limit = deps.pendingActionScanLimit ?? 50;
  let actions: AgentAction[];
  try {
    actions = await deps.client.listAgentActions({ limit });
  } catch (err) {
    deps.log(`scheduler: listAgentActions failed: ${describeError(err)}`);
    return;
  }
  // listAgentActions returns most-recent first; reverse so oldest pending
  // dials in this tick window. With the server's single-active-action lock
  // this loop normally has at most one row to drive.
  for (const action of [...actions].reverse()) {
    if (action.result !== 'pending') continue;
    if (action.callId !== null) continue;
    if (action.kind !== 'place_call') continue;
    try {
      await dialer.dial({
        id: action.id,
        targetDeviceId: action.targetDeviceId,
      });
      result.dialed.push(action.id);
    } catch (err) {
      const message = describeError(err);
      deps.log(`scheduler: action #${action.id} dial failed: ${message}`);
      result.dialErrors.push({ actionId: action.id, message });
    }
  }
}

export function startAgentScheduler(deps: AgentSchedulerDeps & {
  tickMs?: number;
}): () => Promise<void> {
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  let stopped = false;
  let active: Promise<void> = Promise.resolve();
  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        await tickOnce(deps);
      } catch (err) {
        deps.log(`scheduler: tick failed: ${describeError(err)}`);
      }
      if (stopped) return;
      await delay(tickMs);
    }
  };
  active = loop();
  return async () => {
    stopped = true;
    await active;
  };
}

function isDue(rule: AgentRule, now: Date): boolean {
  if (!rule.enabled) return false;
  const next = Date.parse(rule.nextFireAt);
  if (Number.isNaN(next) || next > now.getTime()) return false;
  if (rule.lastFiredAt !== null && rule.cooldownSec > 0) {
    const lastFired = Date.parse(rule.lastFiredAt);
    if (!Number.isNaN(lastFired) && lastFired + rule.cooldownSec * 1000 > now.getTime()) {
      return false;
    }
  }
  return true;
}

async function advanceRule(
  client: EalClient,
  rule: AgentRule,
  now: Date,
): Promise<void> {
  const nextFireAt = computeNextFireAt(rule, now);
  const input: UpsertAgentRuleInput = {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    targetDeviceId: rule.targetDeviceId,
    kind: rule.kind,
    body: rule.body,
    systemPrompt: rule.systemPrompt,
    nextFireAt,
    intervalSec: rule.intervalSec,
    cooldownSec: rule.cooldownSec,
  };
  await client.upsertAgentRule(input);
}

function computeNextFireAt(rule: AgentRule, now: Date): string {
  if (rule.intervalSec === null) {
    // One-shot. Push it far enough into the future that `isDue` returns
    // false on every subsequent tick until an admin edits the rule
    // again. A century from now is the simplest "indefinite" sentinel.
    return new Date(now.getTime() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString();
  }
  return new Date(now.getTime() + rule.intervalSec * 1000).toISOString();
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 24 kHz mono is the TTS provider contract (see voice-providers.ts);
 * the family-phone wire and the voicemail schema default to it too.
 */
const VOICE_MESSAGE_SAMPLE_RATE = 24_000;

/** Cap the synthesis to a safe upper bound so a runaway prompt cannot
 * fill SQLite with an hours-long blob. 60 seconds × 24 kHz × 2 bytes
 * = 2.88 MB — generous for a household voicemail. */
const VOICE_MESSAGE_MAX_BYTES = 60 * VOICE_MESSAGE_SAMPLE_RATE * 2;

/**
 * Decide what spoken text a voice_message rule should produce. A
 * `body` rule speaks the literal string; a `systemPrompt` rule asks
 * Claude to generate it. Returns null if the rule supplies neither
 * (which the api also rejects, but the scheduler is defensive in case
 * the row was edited under a future relaxed CHECK).
 */
async function resolveVoiceMessageText(
  rule: AgentRule,
  deps: AgentSchedulerDeps,
): Promise<string | null> {
  if (rule.body !== null && rule.body.trim().length > 0) return rule.body.trim();
  if (rule.systemPrompt !== null && rule.systemPrompt.trim().length > 0) {
    if (deps.claudeRunner === undefined) {
      deps.log(`scheduler: rule #${rule.id} systemPrompt set but no claudeRunner; cannot generate`);
      return null;
    }
    const nowIso = new Date().toISOString();
    const { content } = await deps.claudeRunner(
      {
        conversation: [
          {
            id: 0,
            role: 'user',
            content: rule.systemPrompt,
            createdBy: 0,
            createdAt: nowIso,
          },
        ],
        sessionId: null,
      },
      () => {
        // Voice messages are one-shot; no streaming consumer.
      },
    );
    const trimmed = content.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  return null;
}

/**
 * Collect every Int16Array chunk a TtsProvider yields into a single
 * 16-bit signed little-endian byte buffer suitable for posting to
 * `/api/family-phone/voice-messages`. The cap protects the SQLite
 * blob column from a misbehaving synthesiser.
 */
async function synthesise(
  tts: TtsProvider,
  text: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Int16Array[] = [];
  let total = 0;
  for await (const chunk of tts.speak(text)) {
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total > VOICE_MESSAGE_MAX_BYTES) {
      throw new Error(`voice message synthesis exceeded ${VOICE_MESSAGE_MAX_BYTES} bytes`);
    }
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      view.setInt16(offset, chunk[i] ?? 0, true);
      offset += 2;
    }
  }
  return out;
}
