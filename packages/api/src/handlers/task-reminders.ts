import webpush from 'web-push';
import { createStoppableDelay } from '@eal/shared';
import { createPushSubscriptionsRepo, type PushSubscriptionRow } from '../db/repos/push-subscriptions.ts';
import { createTasksRepo, systemClock, type Clock, type TaskRow } from '../db/repos/tasks.ts';
import type { DatabaseClient } from '../db/client.ts';
import type { PushVapidConfig } from './push.http.ts';

/**
 * Due-date reminders — the scan that makes `due_at` mean something when the app
 * is closed.
 *
 * It runs **in the api process**, not in the agent worker. A reminder whose
 * delivery depends on the machine in the spare room being awake is not a
 * reminder; the api is the part of eal that is always up, so the scan lives
 * where the uptime is.
 *
 * Everything time-shaped here is a parameter — the clock, the poll interval and
 * the sender — because a test cannot wait sixty seconds and must not reach a
 * push vendor. That is the same shape the tasks repo already takes its `Clock`
 * in (db/repos/tasks.ts).
 */

/** The poll cadence. A minute is the resolution a household deadline needs. */
export const DEFAULT_REMINDER_TICK_MS = 60_000;

/** What web-push needs to address one browser. */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Deliver one notification, or throw. Production passes
 * {@link createWebPushSender}; tests and the multi-tier harness pass their own
 * so nothing leaves the machine.
 */
export type PushSender = (target: PushTarget, payload: string) => Promise<void>;

/**
 * The payload shape the service worker already parses — see the `serviceWorker`
 * source in spa.ts, which reads exactly these five fields and ignores the rest.
 * `kind` is not 'call', so the SW picks the single-buzz vibrate pattern rather
 * than the three-buzz ring.
 */
export interface TaskReminderPayload {
  kind: 'task';
  title: string;
  body: string;
  tag: string;
  url: string;
}

export function taskReminderPayload(task: TaskRow): TaskReminderPayload {
  return {
    kind: 'task',
    // The task's own title is the notification title. On a locked phone the
    // title is the line that is always legible and the body may be truncated
    // away, so the words that identify the task belong in it.
    title: task.title,
    body: 'Due now',
    // One notification per task: a second push for the same row replaces the
    // first on the lock screen instead of stacking beside it.
    tag: `task:${task.id}`,
    url: '/tasks',
  };
}

export interface TaskReminderTickDeps {
  db: DatabaseClient;
  send: PushSender;
  /** "Now", as a SQLite datetime string. Defaults to the real wall clock. */
  clock?: Clock;
}

export interface TaskReminderTickResult {
  /** Tasks whose deadline had passed and which had not been reminded yet. */
  due: number;
  /** Individual notifications handed to the sender. */
  sent: number;
  /** Subscriptions dropped because the vendor said they were gone. */
  dropped: number;
  /** Tasks stamped `reminded_at` by this run. */
  stamped: number;
}

/**
 * web-push throws errors carrying a `statusCode` field on vendor responses.
 * Read it defensively without casting — `unknown` flows through structural
 * narrowing, and `as` is banned repo-wide.
 */
function readWebPushStatusCode(err: unknown): number {
  if (typeof err !== 'object' || err === null) return 0;
  if (!('statusCode' in err)) return 0;
  const candidate = err.statusCode;
  return typeof candidate === 'number' ? candidate : 0;
}

/**
 * Build the scan. Calling the returned function performs exactly one pass and
 * resolves when every send it started has settled — so a caller can await a
 * tick and then assert on what it did, which is what both the unit tests and
 * `scripts/e2e-task-reminder.ts` rely on.
 *
 * The pass is idempotent by construction: it selects only rows with
 * `reminded_at IS NULL`, and stamps every row it processed. Restarting the
 * process mid-scan re-runs at most the rows that had not been stamped.
 */
export function createTaskReminderTick(
  deps: TaskReminderTickDeps,
): () => Promise<TaskReminderTickResult> {
  const tasks = createTasksRepo(deps.db);
  const subscriptions = createPushSubscriptionsRepo(deps.db);
  const clock = deps.clock ?? systemClock;

  return async function tick(): Promise<TaskReminderTickResult> {
    const now = clock();
    const due = tasks.list({
      // Not done — the one spelling of that predicate, shared with the Today
      // view. **A blocked task still reminds**: blocked and overdue is the most
      // useful reminder there is, the case where something is waiting on a
      // person and the deadline has now passed.
      unfinished: true,
      dueOnOrBefore: now,
      notReminded: true,
    });
    const result: TaskReminderTickResult = { due: due.length, sent: 0, dropped: 0, stamped: 0 };
    if (due.length === 0) return result;

    // One read of the whole subscription set per pass rather than per task: a
    // household has a handful of rows and most ticks carry several tasks.
    const everyone = subscriptions.listAll();

    for (const task of due) {
      // Assigned to someone: only they are told. Unassigned: everyone is, which
      // is the honest answer to "whose is this?" — nobody's yet, so the house
      // hears it.
      const targets =
        task.assigned_to === null
          ? everyone
          : everyone.filter((row) => row.user_id === task.assigned_to);
      const payload = JSON.stringify(taskReminderPayload(task));

      for (const target of targets) {
        try {
          await deps.send(
            { endpoint: target.endpoint, p256dh: target.p256dh, auth: target.auth },
            payload,
          );
          result.sent += 1;
        } catch (err) {
          const statusCode = readWebPushStatusCode(err);
          if (statusCode === 404 || statusCode === 410) {
            // The vendor says this subscription no longer exists — the browser
            // profile was cleared, or the user revoked notifications. It will
            // never accept another push, so drop the row rather than spend a
            // round trip on it every minute for the life of the install. The
            // browser re-registers a fresh endpoint the next time someone taps
            // "Remind me".
            subscriptions.deleteByEndpoint(target.endpoint);
            removeInPlace(everyone, target.endpoint);
            result.dropped += 1;
          } else {
            // Anything else — a vendor 500, a DNS blip, a TLS error — is
            // logged and dropped. It is deliberately NOT retried on the next
            // tick: see the stamp below.
            console.warn(`[reminders] send failed for task ${task.id}:`, err);
          }
        }
      }

      // Stamped once the pass has been round this task, whatever the vendor
      // said and even when there was nobody to tell.
      //
      // The alternative — stamp only on a successful send — retries a broken
      // vendor every sixty seconds for as long as the row is overdue, and a
      // deadline that finally rings forty minutes late is worse than one that
      // did not ring at all. It also means a household that turns notifications
      // on this afternoon is buried under every deadline that passed before
      // they did, which is the first impression the feature would then make.
      //
      // Re-arming stays in the user's hands, where it belongs: writing `due_at`
      // to a new value clears the stamp (db/repos/tasks.ts:update), so moving a
      // deadline you missed schedules it again.
      if (tasks.markReminded(task.id, now)) result.stamped += 1;
    }

    return result;
  };
}

/** Drop the row with this endpoint from an in-memory list, in place. */
function removeInPlace(rows: PushSubscriptionRow[], endpoint: string): void {
  const at = rows.findIndex((row) => row.endpoint === endpoint);
  if (at >= 0) rows.splice(at, 1);
}

/**
 * The production sender.
 *
 * The VAPID identity is passed per call rather than left to the module-global
 * `setVapidDetails` that server.ts installs at boot. Both are set from the same
 * three env vars, and being explicit means this sender is a pure function of
 * its argument — constructible in a test, and impossible to leave silently
 * bound to whatever identity some other module configured last.
 *
 * TTL is an hour: a phone that was off when the deadline passed should still
 * buzz when it comes back within the hour, and a reminder older than that has
 * been overtaken by the day.
 */
export function createWebPushSender(vapid: PushVapidConfig): PushSender {
  return async function send(target, payload) {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      payload,
      {
        TTL: 3600,
        vapidDetails: {
          subject: vapid.subject,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
        },
      },
    );
  };
}

export interface ReminderLoop {
  /** Stop before the next tick. Idempotent. */
  stop(): void;
  /** Resolves once the loop has stopped and its in-flight tick has settled. */
  readonly finished: Promise<void>;
}

export interface ReminderLoopOptions {
  tick: () => Promise<unknown>;
  intervalMs: number;
  /** Names the loop in the warning printed when a tick throws. */
  label?: string;
}

/**
 * Run `tick` now, then every `intervalMs` until stopped.
 *
 * The first pass is immediate on purpose. The process restarts on every deploy,
 * and a deadline that passed during the restart should not wait out a fresh
 * interval before anyone hears about it.
 *
 * `delay` — not `pollUntil` — because there is no condition to observe here:
 * the wait between passes *is* the behaviour, which is the one case
 * packages/shared/src/timers.ts sanctions a fixed delay for.
 */
export function startReminderLoop(opts: ReminderLoopOptions): ReminderLoop {
  const label = opts.label ?? 'reminders';
  const cadence = createStoppableDelay();

  const finished = (async (): Promise<void> => {
    while (!cadence.stopped) {
      try {
        await opts.tick();
      } catch (err) {
        // A thrown tick must not kill the loop — the next deadline still needs
        // scanning for. Anything reaching here is a bug or a dead database, and
        // both want a line in the log rather than silence.
        console.warn(`[${label}] tick failed:`, err);
      }
      if (cadence.stopped) break;
      await cadence.wait(opts.intervalMs);
    }
  })();

  return {
    stop(): void {
      // Stopping mid-interval must not mean waiting out the rest of it, and
      // must not leave a timer alive to hold the process open — which is why
      // this is `createStoppableDelay` and not `delay`.
      cadence.stop();
    },
    finished,
  };
}

/**
 * How often the scan runs, from the environment.
 *
 * The default is the constant above; `EAL_REMINDER_TICK_MS` overrides it. This
 * is not deployment configuration and production never sets it — it exists so
 * `scripts/e2e-task-reminder.ts` can watch two consecutive ticks inside a few
 * seconds instead of two minutes. Set to anything that is not a positive
 * integer it throws at boot rather than quietly falling back, which is the
 * house rule for every value read out of the environment.
 */
export function resolveReminderTickMs(env: NodeJS.ProcessEnv): number {
  const raw = env['EAL_REMINDER_TICK_MS'];
  if (raw === undefined || raw === '') return DEFAULT_REMINDER_TICK_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new Error(
      `EAL_API: EAL_REMINDER_TICK_MS="${raw}" is not a positive integer of milliseconds.`,
    );
  }
  return ms;
}
