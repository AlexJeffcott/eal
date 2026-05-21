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
    ],
    browser: ['packages/web/tests/browser/tasks.browser.tsx'],
    e2e: ['packages/e2e-tests/tests/tasks.spec.ts'],
    mutate: ['packages/web/src/apps/tasks/filter.ts'],
  },
];

export function appById(id: string): AppVerification | undefined {
  return APPS.find((app) => app.id === id);
}
