import { defineConfig, devices } from '@playwright/test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const WEB_PORT = process.env['EAL_WEB_PORT'] ?? '3001';
// localhost (not 127.0.0.1) is required for WebAuthn to accept rpID='localhost'.
const BASE_URL = `https://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: './tests',
  // Serial execution. The api server backing this tier holds shared state
  // (sessions, users, WS subscribers, the in-process challenge store). Running
  // tests in parallel produces races (cross-test WS broadcasts, stale users
  // from previous runs, etc.). Serial costs ~10s for ~10 tests but is reliable.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: 'line',
  timeout: 30_000,

  webServer: {
    command: 'bun devctl dev',
    cwd: ROOT,
    url: BASE_URL,
    ignoreHTTPSErrors: true,
    // Always boot a fresh server. `:memory:` sqlite means a reused server
    // carries state across runs — registered users, minted sessions — which
    // confounds clean assertions. Pay the ~2s boot cost for hermetic runs.
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: WEB_PORT,
      DATABASE_PATH: ':memory:',
      // The server requires EAL_ORIGIN (no fallback); it must match the host
      // and port the browser hits, or WebAuthn rejects the passkey ceremony.
      EAL_ORIGIN: BASE_URL,
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
      // Pin the PSTN trunk off. Bun auto-loads the developer's `.env`, and a
      // half-filled trunk there (`TWILIO_ENABLED=true` with the number still
      // to buy) stops the server booting at all. No spec here drives PSTN;
      // `scripts/e2e-pstn-*.ts` own that path and boot their own trunk.
      TWILIO_ENABLED: 'false',
      // Registration is closed without this (packages/api/src/auth/registration.ts).
      // Keep it identical to E2E_INVITE_CODE in tests/lib/shell.ts.
      EAL_INVITE_CODE: 'playwright-invite-code-0123456789',
    },
  },

  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // The 350px floor on a real mobile profile: touch input, a mobile user
      // agent, device pixel ratio and `viewport-fit=cover` all in play. A
      // narrowed desktop window exercises none of those. Chromium-based on
      // purpose — the WebKit device profiles cannot drive the CDP virtual
      // authenticator every signed-in spec needs.
      //
      // Scoped by `grep` to the viewport cases: running the whole suite twice
      // buys nothing, and these are the tests whose result changes with the
      // device profile.
      name: 'mobile-350',
      grep: /350px|floor/,
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 350, height: 750 },
      },
    },
  ],
});
