/**
 * Per-file coverage policy. Read by `scripts/enforce-coverage.ts`.
 *
 * - `defaultThreshold`: applied to every covered file not listed in `exempt`.
 *   Both `lines` and `funcs` must meet or exceed it.
 * - `exempt`: files NOT subject to the unit-tier threshold. Each entry must
 *   carry both `reason` (why) and `claimedBy` (which test file makes the
 *   "covered elsewhere" claim true). The enforcer fails if either path
 *   doesn't exist on disk so a dead exemption can't silently rot.
 *
 * The shape is intentionally TS code (not JSON) so the rules participate in
 * `tsc --noEmit` — a typo in a file path is a type error.
 */

export interface FileThreshold {
  lines: number;
  funcs: number;
}

export interface ExemptEntry {
  reason: string;
  /**
   * Path (repo-relative) to the test or script that exercises this file at a
   * higher tier. Verified to exist by `enforce-coverage.ts`. Use
   * `'n/a — <reason>'` for genuine waivers (e.g. unused code).
   */
  claimedBy: string;
}

export interface CoverageConfig {
  defaultThreshold: FileThreshold;
  exempt: Record<string, ExemptEntry>;
}

export const config: CoverageConfig = {
  defaultThreshold: { lines: 80, funcs: 80 },
  exempt: {
    'packages/api/src/handlers/auth.shared.ts': {
      reason: 'e2e: register/login flow needs the real ceremony',
      claimedBy: 'packages/e2e-tests/tests/auth.spec.ts',
    },
    'packages/api/src/handlers/auth.http.ts': {
      reason: 'e2e: Elysia route wiring is exercised by playwright',
      claimedBy: 'packages/e2e-tests/tests/auth.spec.ts',
    },
    'packages/api/src/server.ts': {
      reason: 'e2e/multi: server boot is observed by bootApi + curl',
      claimedBy: 'scripts/e2e-tasks-multi.ts',
    },
    'packages/api/src/server-factory.ts': {
      reason: 'e2e: full app factory is exercised by playwright',
      claimedBy: 'packages/e2e-tests/tests/health.spec.ts',
    },
    'packages/api/src/spa.ts': {
      reason: 'e2e: Bun.build + Bun.serve is exercised by playwright',
      claimedBy: 'packages/e2e-tests/tests/health.spec.ts',
    },
    'packages/client/src/eal-client.ts': {
      reason: 'real client only meaningfully exercised by playwright (full HTTPS + WSS flow)',
      claimedBy: 'packages/e2e-tests/tests/auth.spec.ts',
    },
    'packages/cli/src/commands/auth.ts': {
      reason: 'cores unit-tested; thin login/status/logout wrappers exercised by e2e-auth-multi',
      claimedBy: 'scripts/e2e-auth-multi.ts',
    },
    'packages/cli/src/commands/pair.ts': {
      reason: 'core unit-tested; realDeps + command wrapper exercised by e2e-cli-pair',
      claimedBy: 'scripts/e2e-cli-pair.ts',
    },
    'packages/api/src/auth/middleware.ts': {
      reason: 'Elysia plugin wiring — derived per-request, exercised end-to-end by every route',
      claimedBy: 'scripts/e2e-auth-multi.ts',
    },
    'packages/client-mock/src/mock-eal-client.ts': {
      reason: 'mock client exercised by the polly browser tier (different test runner)',
      claimedBy: 'packages/web/tests/browser/sign-in.browser.tsx',
    },
    'packages/web/src/shell/actions.ts': {
      reason: 'error mappers unit-tested in registry.test.ts; shell action dispatchers run in the polly browser tier',
      claimedBy: 'packages/web/tests/browser/sign-in.browser.tsx',
    },
    'packages/web/src/apps/tasks/actions.ts': {
      reason: 'tasks action dispatchers run in the polly browser tier',
      claimedBy: 'packages/web/tests/browser/tasks.browser.tsx',
    },
    'packages/web/src/apps/family-phone/audio.ts': {
      reason: 'WebAudio capture/playback — AudioWorklet + getUserMedia only meaningful in a real browser',
      claimedBy: 'n/a — exercised by manual two-browser call session',
    },
    'packages/web/src/apps/family-phone/ringtone.ts': {
      reason: 'core start/stop/isPlaying unit-tested; the catch branches around oscillator.stop and AudioContext.close fire only on browser implementation quirks and are exercised by the e2e ringtone harness',
      claimedBy: 'scripts/e2e-family-phone-ringtone.ts',
    },
    'packages/web/src/apps/family-phone/stores.ts': {
      reason: 'call-only signals; reads exercised by actions.test.ts, createFamilyPhoneStores/reset by the shell composition root',
      claimedBy: 'packages/web/src/apps/family-phone/actions.test.ts',
    },
    'packages/web/src/apps/family-phone/actions.ts': {
      reason: 'installCallEventHandlers wiring unit-tested; place-call/accept/etc dispatchers run in the polly browser tier and against the live api',
      claimedBy: 'packages/web/src/apps/family-phone/actions.test.ts',
    },
    'packages/web/src/apps/devices/stores.ts': {
      reason: 'devices signals; reads exercised by actions.test.ts, factory/reset by the shell composition root',
      claimedBy: 'packages/web/src/apps/family-phone/actions.test.ts',
    },
    'packages/web/src/shell/router.ts': {
      reason: 'navigate() is exercised by nav.browser.tsx; the popstate wiring is boot glue',
      claimedBy: 'packages/web/tests/browser/nav.browser.tsx',
    },
    'packages/cli/src/lib/log.ts': {
      reason: 'console facade — exercised by every cli invocation in multi-process scripts',
      claimedBy: 'scripts/e2e-auth-multi.ts',
    },
    'packages/cli/src/lib/process.ts': {
      reason: 'exit/log facades — exercised by every cli invocation in multi-process scripts',
      claimedBy: 'scripts/e2e-auth-multi.ts',
    },
    'packages/api/src/handlers/messages.http.ts': {
      reason: 'GET route + error envelope wiring — exercised end-to-end by the chat relay',
      claimedBy: 'scripts/e2e-chat.ts',
    },
    'packages/api/src/handlers/users.http.ts': {
      reason: 'roster route + error envelope — exercised by the SPA boot in playwright',
      claimedBy: 'packages/e2e-tests/tests/auth.spec.ts',
    },
    'packages/cli/src/commands/agent.ts': {
      reason: 'handleChatRequest is unit-tested; the connect/reconnect daemon loop runs in the chat e2e',
      claimedBy: 'scripts/e2e-chat.ts',
    },
    'packages/cli/src/commands/agent-pair-phone.ts': {
      reason: 'core unit-tested; realDeps wrapper + real WebCrypto key generation exercised once the voice-call e2e lands',
      claimedBy: 'n/a — exercised manually via `eal agent pair-phone` against a running api until scripts/e2e-agent-voice-call.ts lands',
    },
    'packages/cli/src/commands/stt-whisper.ts': {
      reason: 'cleanWhisperOutput unit-tested; the spawn/fetch paths are exercised against real whisper.cpp and the OpenAI API in manual bring-up',
      claimedBy: 'n/a — exercised manually until scripts/e2e-agent-voice-call.ts lands',
    },
    'packages/cli/src/commands/tts-piper.ts': {
      reason: 'wav/resample helpers unit-tested; the spawn paths are exercised against real piper and macOS say in manual bring-up',
      claimedBy: 'n/a — exercised manually until scripts/e2e-agent-voice-call.ts lands',
    },
    'packages/cli/src/commands/claude-runner.ts': {
      reason: 'pure helpers unit-tested; the real `claude` subprocess is exercised by the chat e2e',
      claimedBy: 'scripts/e2e-chat.ts',
    },
    'packages/cli/src/commands/mcp.ts': {
      reason: 'tool runners unit-tested; the stdio MCP server wiring runs under `claude` in the chat e2e',
      claimedBy: 'scripts/e2e-chat.ts',
    },
  },
};
