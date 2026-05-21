# Browser tier — scope

These tests run the SPA inside the polly browser harness with **`MockEalClient`** wired in. They are component tests, not integration tests.

## What this tier IS for

- Asserting that the SPA renders the right DOM for a given client state.
- Asserting that `$state` reactivity drives re-render correctly.
- Asserting that user input (clicks, form fills) calls the right `EalClient` method with the right arguments.
- Asserting auth-driven view branching (sign-in surface vs. authenticated surface) by toggling `mock.setCurrentUser(...)`.

The `MockEalClient` is the boundary. Everything seaward of it is in scope; everything landward (network, sqlite, real Elysia handlers, real WebAuthn) is out.

## What this tier IS NOT for

- **NOT for real-api integration.** The mock returns whatever the test seeds. If the real api drifts from what the mock returns, this tier will not catch it. That divergence is closed by:
  - `scripts/e2e-client-contract.ts` — runs the same call sequence against `EalClient` (real api) and `MockEalClient` and asserts shape equality.
  - `packages/e2e-tests/tests/*.spec.ts` — Playwright drives the SPA against a real booted api with a real WebAuthn Virtual Authenticator.
- **NOT for end-to-end happy paths.** A green browser test does NOT prove the user-facing feature works. See `packages/e2e-tests/tests/auth.spec.ts` for the actual register → sign-out → sign-in regression that catches WebAuthn handshake bugs.
- **NOT for asserting `EalClient` behavior.** That belongs in `packages/api/src/handlers/*.parity.test.ts` (HTTP/WS parity) and `scripts/e2e-*-multi.ts` (cold-state multi-process).
- **NOT for asserting auth provider behavior.** WebAuthn ceremony testing is owned by `packages/e2e-tests/tests/auth.spec.ts` (single-browser ceremony) and `scripts/e2e-passkey-multi.ts` (cross-process credential roaming).

## Why this split

The browser tier runs in milliseconds and is the right place to assert "given state X, render Y." Mocking the client keeps it fast and deterministic. The cost is that any bug between `MockEalClient` and the real `EalClient` is invisible here — which is exactly why the contract test and the Playwright tier exist alongside it.

A green browser tier alone is necessary but not sufficient for shipping. See the root CLAUDE.md "Green checks do not prove features work" section for the wider context.
