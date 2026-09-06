import { API_APPS } from './registry.ts';
import type { ApiApp, ApiAppBackgroundContext, ApiAppBackgroundTask } from './types.ts';

/**
 * Start every installed app's background worker, and hand back one handle that
 * stops them all.
 *
 * This is the *only* thing that calls `ApiApp.start`, and `bootServer` in
 * server.ts is the only thing that calls this. Building an app — which is what
 * `createAppInternal`, and therefore `createTestApp`, does — starts nothing.
 * That separation is the whole point: a test app must not acquire a timer, and
 * the way to be sure of it is that the code which could give it one is not on
 * the path a test takes. `background.test.ts` proves both halves.
 */
export interface BackgroundTasks extends ApiAppBackgroundTask {
  /** Which apps actually started something — the rest declined or have none. */
  readonly started: readonly string[];
}

export function startAppBackground(
  ctx: ApiAppBackgroundContext,
  apps: readonly ApiApp[] = API_APPS,
): BackgroundTasks {
  const running: ApiAppBackgroundTask[] = [];
  const started: string[] = [];
  for (const app of apps) {
    if (!app.start) continue;
    const task = app.start(ctx);
    // An app declines by returning null — unconfigured, and honest about it.
    if (task === null) continue;
    running.push(task);
    started.push(app.id);
  }
  return {
    started,
    stop(): void {
      for (const task of running) task.stop();
    },
  };
}
