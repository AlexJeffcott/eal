import type {
  AgentAction,
  AgentRule,
  EalClient,
  UpsertAgentRuleInput,
} from '@eal/client';
import { assertNever, delay } from '@eal/shared';
import type { AgentOutboundDialer } from './agent-outbound-dialer.ts';

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
          // Voicemail storage lands in a follow-up commit. For now the
          // rule is recognised but its action is deferred — leave
          // `nextFireAt` unchanged so the rule re-fires when the path
          // is wired up. The admin notices via the log line.
          deps.log(
            `scheduler: rule #${rule.id} kind=voice_message not yet implemented; left untouched`,
          );
          result.notImplemented.push(rule.id);
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
