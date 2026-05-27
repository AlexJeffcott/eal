import type { FunctionComponent } from 'preact';
import { TasksPanel } from './tasks/tasks-panel.tsx';
import { ShowcasePanel } from './showcase/showcase-panel.tsx';
import { DevicesPanel } from './devices/devices-panel.tsx';
import { FamilyPhonePanel } from './family-phone/family-phone-panel.tsx';
import { AgentRulesPanel } from './agent-rules/agent-rules-panel.tsx';

/**
 * A web app — a feature mounted into the shell at its own path. The shell
 * renders the nav from this registry and mounts the active app's `root`.
 *
 * An `authed` app registers on all three layers (web here, plus an API app and
 * MCP tools) and renders only behind sign-in. A `public` app registers on this
 * layer *only* — no API app, no DB schema, no MCP tools. It is a pure
 * client-side route, served to anyone, and by that constraint cannot touch
 * gated data. Keep it that way: a public app must never gain an API surface.
 */
export interface WebApp {
  id: string;
  /** The path the shell routes to this app, e.g. `/tasks`. */
  path: string;
  /** Nav + landing-card label. */
  label: string;
  /** One-line description for the landing launcher. */
  description: string;
  /**
   * `authed` — gated behind sign-in (the default kind of app).
   * `public` — renders signed-out; must have no API/DB/MCP layer.
   */
  access: 'authed' | 'public';
  root: FunctionComponent;
}

export const WEB_APPS: readonly WebApp[] = [
  {
    id: 'tasks',
    path: '/tasks',
    label: 'Tasks',
    description: 'Shared and personal tasks — details, scheduling, assignees, subtasks.',
    access: 'authed',
    root: TasksPanel,
  },
  {
    id: 'showcase',
    path: '/showcase',
    label: 'Showcase',
    description: 'Every polly UI component and its configuration options — a reference catalogue.',
    access: 'public',
    root: ShowcasePanel,
  },
  {
    id: 'devices',
    path: '/devices',
    label: 'Devices',
    description: 'Join the household, invite new devices, and manage the directory.',
    access: 'authed',
    root: DevicesPanel,
  },
  {
    id: 'family-phone',
    path: '/family-phone',
    label: 'Phone',
    description: 'Voice calls between paired household devices.',
    access: 'authed',
    root: FamilyPhonePanel,
  },
  {
    id: 'agent-rules',
    path: '/agent-rules',
    label: 'Proactivity',
    description: "Rules for when the assistant calls or messages someone in the household.",
    access: 'authed',
    root: AgentRulesPanel,
  },
];

/** The app that owns `pathname`, or null (the landing page / unknown route). */
export function appForPath(pathname: string): WebApp | null {
  return (
    WEB_APPS.find((a) => pathname === a.path || pathname.startsWith(`${a.path}/`)) ?? null
  );
}
