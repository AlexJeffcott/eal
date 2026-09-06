/**
 * Per-app verification manifest.
 *
 * In eal's shell/apps architecture an app registers on three layers (web, api,
 * cli) via per-layer `apps/registry.ts` files. This manifest is the fourth
 * registration — the test and mutation surface the app owns — so an app can be
 * verified as a unit rather than as scattered files across packages.
 *
 * Consumed by:
 *   - `devctl test --app <id>` — run one app's unit + browser + e2e tests
 *   - `devctl test mutation`   — compose Stryker's `mutate` list (the global
 *                                files in stryker.conf.json plus every app's
 *                                `mutate`); each file is listed exactly once.
 *
 * All paths are repo-relative.
 */
export interface AppVerification {
  /** Matches the app id used in the web/api/cli `apps/registry.ts` files. */
  id: string;
  /** Bun unit-test files. */
  unit: string[];
  /** Polly browser-test files. */
  browser: string[];
  /** Playwright e2e spec files. */
  e2e: string[];
  /** Source files this app contributes to mutation testing. */
  mutate: string[];
}

export const APPS: readonly AppVerification[] = [
  {
    id: 'tasks',
    unit: [
      'packages/web/src/apps/tasks/filter.test.ts',
      'packages/api/src/db/repos/tasks.test.ts',
      'packages/api/src/handlers/tasks.http.test.ts',
      'packages/api/src/handlers/tasks.shared.test.ts',
      'packages/cli/src/commands/mcp.test.ts',
      'packages/client/src/task-availability.test.ts',
      'packages/client/src/task-availability.property.test.ts',
    ],
    browser: ['packages/web/tests/browser/tasks.browser.tsx'],
    e2e: ['packages/e2e-tests/tests/tasks.spec.ts'],
    mutate: [
      'packages/web/src/apps/tasks/filter.ts',
      // The availability rule is the whole of stage 3 and lives in @eal/client
      // so the SPA and the assistant answer "what next" identically. It is
      // mutated with the filter it feeds.
      'packages/client/src/task-availability.ts',
    ],
  },
  {
    // A public, web-only app: no API, DB, or MCP layer, so no unit surface and
    // nothing to mutate — it is presentational. Verified at the browser and
    // e2e tiers.
    id: 'showcase',
    unit: [],
    browser: ['packages/web/tests/browser/showcase.browser.tsx'],
    e2e: ['packages/e2e-tests/tests/showcase.spec.ts'],
    mutate: [],
  },
  {
    id: 'family-phone',
    unit: [
      'packages/web/src/apps/family-phone/actions.test.ts',
      'packages/web/src/apps/family-phone/notifications.test.ts',
      'packages/web/src/apps/family-phone/ringtone.test.ts',
      'packages/web/src/apps/family-phone/voicemail-actions.test.ts',
      'packages/api/src/handlers/family-phone.http.test.ts',
      'packages/api/src/handlers/family-phone.ws.test.ts',
      'packages/api/src/handlers/family-phone-voicemail.http.test.ts',
      'packages/api/src/handlers/family-phone-device-auth.http.test.ts',
      'packages/api/src/handlers/family-phone-pair.http.test.ts',
      'packages/api/src/db/repos/family-phone-push-subscriptions.test.ts',
      'packages/api/src/db/repos/family-phone-voice-messages.test.ts',
      'packages/cli/src/apps/family-phone.test.ts',
    ],
    browser: [],
    e2e: ['packages/e2e-tests/tests/family-phone.spec.ts'],
    mutate: [
      'packages/api/src/handlers/family-phone.ws.ts',
      'packages/api/src/handlers/family-phone-pair.shared.ts',
      'packages/api/src/handlers/family-phone-device-auth.shared.ts',
      'packages/api/src/db/repos/family-phone-voice-messages.ts',
    ],
  },
  {
    id: 'agent-rules',
    unit: [
      'packages/api/src/handlers/agent-rules.http.test.ts',
      'packages/api/src/db/repos/agent-rules.test.ts',
      'packages/web/src/apps/agent-rules/actions.test.ts',
    ],
    browser: [],
    e2e: ['packages/e2e-tests/tests/agent-rules.spec.ts'],
    mutate: [
      'packages/api/src/db/repos/agent-rules.ts',
    ],
  },
  {
    id: 'pstn-contacts',
    unit: [
      'packages/api/src/db/repos/family-phone-pstn-contacts.test.ts',
      'packages/api/src/handlers/family-phone-pstn-contacts.http.test.ts',
      'packages/web/src/apps/pstn-contacts/actions.test.ts',
    ],
    browser: ['packages/web/tests/browser/pstn-contacts.browser.tsx'],
    e2e: ['packages/e2e-tests/tests/pstn-contacts.spec.ts'],
    mutate: [
      'packages/api/src/db/repos/family-phone-pstn-contacts.ts',
      'packages/api/src/handlers/family-phone-pstn-contacts.http.ts',
    ],
  },
];

export function appById(id: string): AppVerification | undefined {
  return APPS.find((app) => app.id === id);
}
