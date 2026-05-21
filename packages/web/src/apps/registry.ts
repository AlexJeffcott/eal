import type { FunctionComponent } from 'preact';
import { TasksPanel } from './tasks/tasks-panel.tsx';

/**
 * A web app — a feature mounted into the shell at its own path. The shell
 * renders the nav from this registry and mounts the active app's `root`.
 * Add an app by adding an entry here (plus its API app and MCP tools).
 */
export interface WebApp {
  id: string;
  /** The path the shell routes to this app, e.g. `/tasks`. */
  path: string;
  /** Nav + landing-card label. */
  label: string;
  /** One-line description for the landing launcher. */
  description: string;
  root: FunctionComponent;
}

export const WEB_APPS: readonly WebApp[] = [
  {
    id: 'tasks',
    path: '/tasks',
    label: 'Tasks',
    description: 'Shared and personal tasks — details, scheduling, assignees, subtasks.',
    root: TasksPanel,
  },
];

/** The app that owns `pathname`, or null (the landing page / unknown route). */
export function appForPath(pathname: string): WebApp | null {
  return (
    WEB_APPS.find((a) => pathname === a.path || pathname.startsWith(`${a.path}/`)) ?? null
  );
}
