# Plan 03 — Keep the assistant online

Status: **decided 2026-08-25 — the always-on machine at home.** The code half
is built; the machine half is yours to install.

Built:

| Piece | Where |
|---|---|
| launchd unit, `caffeinate -s`, KeepAlive, 30s throttle | `deploy/com.eal.agent.plist` |
| systemd user unit, `Restart=always`, `RestartSec=30` | `deploy/eal-agent.service` |
| `agent:status` announced to every browser on the first connect and the last disconnect | `packages/api/src/server-factory.ts` |
| `GET /api/v1/agent/status` for a page that has just loaded | same |
| `getAgentStatus()` / `subscribeAgentStatus()` | `packages/client/src/eal-client.ts`, mirrored in the mock |
| Composer disabled with the reason, recovering on its own | `packages/web/src/shell/chat/chat-panel.tsx` |
| 2 browser tests | `packages/web/tests/browser/chat.browser.tsx` |
| Verification artefact | `scripts/e2e-agent-offline.ts` |

Left to do, on the machine you pick:

1. `eal auth pair --label=agent-<hostname>` on it.
2. Copy the unit template, replace the three paths, load it.
3. Stop the machine sleeping — `caffeinate -s` is already in the plist; on a
   mains-powered Mac `sudo pmset -a sleep 0` is the blunter alternative.
4. Watch the first week's log for a `claude` session that expires.

## The reading

The assistant answers only while an `eal agent` process holds a WebSocket to
the api.

| Fact | Evidence |
|---|---|
| With no agent connected the relay replies `No assistant is online — start 'eal agent' on a paired device.` | `packages/api/src/server-factory.ts:434` |
| The worker spawns the `claude` CLI binary | `packages/cli/src/commands/claude-runner.ts` |
| The worker reconnects on its own, 1 s → 30 s backoff | `packages/cli/src/commands/agent.ts:37` |
| The web app shows nothing about agent availability before you type | `packages/web/src/shell/chat/chat-panel.tsx` |

Today the worker runs on your laptop. A shut lid means no assistant on the
phone.

## The choice

| Option | Needs | Risk |
|---|---|---|
| **Always-on machine at home** (mac mini, spare laptop, Pi) | outbound WSS only, no ports opened; `claude` already logged in there; a service manager to restart it | home power and internet outages |
| `eal agent` inside the Fly container | the `claude` binary in the image and its credentials as a secret | a subscription credential lives in a server image; refresh behaviour unknown to me |
| An API key instead of the subscription | `ANTHROPIC_API_KEY` | metered spend, and it reverses the decision already recorded for this project |

**Recommendation: the always-on machine.** It keeps the subscription login
where it already works and adds no new secret to the deployment.

## Steps

1. **Pick the machine.** Pair it: `eal auth pair --label=agent-<hostname>`.
2. **Run it as a service.** Commit a template under `deploy/`:
   - macOS: `deploy/com.eal.agent.plist` for `~/Library/LaunchAgents` —
     `RunAtLoad`, `KeepAlive`, stdout and stderr to a log file.
   - Linux: `deploy/eal-agent.service` for systemd — `Restart=always`.
3. **Stop the machine sleeping.** `caffeinate -s` wrapping the command on
   macOS, or `sudo pmset -a sleep 0` on a mains-powered Mac. Record which one
   you chose in `docs/deploy.md`.
4. **Publish agent availability.** The api already holds the connected agents
   in a map (`server-factory.ts:137`). Add
   `GET /api/v1/agent/status` → `{ online: boolean }`, and broadcast a
   `agent:online` / `agent:offline` event on the browser topic so the panel
   updates live.
5. **Show it.** The chat composer is disabled with a plain reason when no agent
   is connected. Better than sending into a hole and reading an error.

## Tests

| Tier | What it asserts |
|---|---|
| unit — `server-factory` seam test | `agent:online` fires on connect, `agent:offline` on close |
| browser — `chat.browser.tsx` | the composer is disabled and states the reason when offline |

Note: `chat.browser.tsx` is the file with the known polly runner flake. A run
that fails only with `timed out after 60000ms waiting for __pollyReport` is a
re-run, not a regression.

## Verification artefact

`scripts/e2e-agent-offline.ts`, run by `bun devctl test multi`. Boot the api
with no agent, send a chat, assert the browser receives `chat:error` carrying
the offline message, then connect a scripted agent and assert a full reply
arrives. Plus the real check, by hand and once: shut the laptop lid, ask a
question from the phone, get an answer.

## Done when

You ask from the phone, with the laptop shut, and the reply arrives in about
ten seconds.

## Not measured

Whether a `claude` CLI login survives a daemon running for days, and what it
does when the session expires. Watch the first week's logs.
