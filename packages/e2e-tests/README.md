# Playwright e2e tier — scope

These tests boot a real api (real Elysia + sqlite + WebAuthn) on HTTPS/WSS and drive a real Chromium browser (with a CDP Virtual Authenticator for passkey ceremonies) through Playwright.

## What this tier IS for

- End-to-end happy-path verification of user-facing features against a real api.
- WebAuthn ceremony testing in a real browser via the CDP Virtual Authenticator.
- Cross-cutting bugs that only surface when the browser, real api, real sqlite, real WS, and real WebAuthn all interact (e.g. the userHandle decoding bug that browser-tier tests cannot catch).
- Anonymous vs. authenticated route protection asserted against the real Elysia handlers.

## What this tier IS NOT for

- **NOT for component reactivity tests.** Those belong in `packages/web/tests/browser/*.browser.tsx` where `MockEalClient` keeps them fast and deterministic.
- **NOT for cross-process scenarios** (multi-device sync, CLI ↔ SPA). Those belong in `scripts/e2e-*-multi.ts` where each process boots independently.
- **NOT for asserting handler logic.** Use unit-tier parity tests (`packages/api/src/handlers/*.parity.test.ts`) — they cover both HTTP and WS in one test.

## Why this split

This tier is slow (real Chromium + real api boot). It earns its cost by being the only tier that exercises the whole stack the user touches. Treat each spec as expensive — write one strong regression per real bug, not a coverage matrix.

See also: `packages/web/tests/browser/README.md` and the root CLAUDE.md "Green checks do not prove features work" section.
