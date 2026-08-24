# family-phone

A hobbyist-built wireless handset and PWA system that lets AJT's family (AJT, spouse, 9-year-old son) call each other and a personal agent over a self-hosted service. Designed for AJT, based in Italy.

Family-phone lives inside eal as a sub-app (`packages/api/src/apps/family-phone.ts`) sharing eal's identity, deploy, and runtime infrastructure. Handset firmware and the LilyGO bring-up scripts remain in the standalone `~/projects/family-phone/` repo — see its README for hardware notes.

## What it is

A private family communication system with two kinds of client:

- **Custom wireless handsets** shaped like the handpiece of an early-80s telephone. One per family member. One physical button on the inside curve. No screen. Runs on cellular data.
- **PWAs** for laptops and phones, so family members without a handset (or away from it) can still participate.

All clients talk to a small self-hosted server (Pi at home) that routes calls, manages identity, and exposes a directory and admin page.

The agent lives in eal alongside the family-phone server. It runs as the `eal agent` CLI worker (`eal/packages/cli/src/commands/agent.ts`), holds a persistent WebSocket to the server as a device of type `agent`, and shows up in family-phone's directory as just another contact. The same worker already answers chat requests from the eal web app; family-phone is its second client surface.

## Aesthetic brief

"An 80s handset that had its cord cut when it got superpowers."

- Read as ordinary at a glance. Familiar curves, familiar speaker and mic clusters, substantial weight, satin-finish plastic.
- The cord scar is preserved, not smoothed out. A single LED lives inside the former cord exit and glows with state (breathing = message waiting, flashing = ringing, dark = idle, etc.). The "superpowers" are literally glowing out of the wound where the cord used to be.
- One subtle modern material cue at most (brushed metal ring around the button, say). No more.
- Colour per family member from the 80s palette (mint green, harvest gold, burnt orange, cream, beige).

## What it does

In priority order:

1. **Voice calls between family members.** Primary path is VoIP over cellular data to the home server. Audio quality is critical.
2. **Press-and-hold to talk to the agent.** Agent is another contact in the directory. Audio goes through the same VoIP path.
3. **Incoming calls from outside the family** (landline, PSTN). Via a VoIP trunk (Twilio, Voxbone, or similar) terminated at the server, which then rings the handset over the same WebSocket audio relay as any other call. The handset modem itself never handles voice.
4. **GPS location reporting.** Passive. Handset posts coordinates to the server every N minutes. Queues locally when out of coverage, flushes on reconnect.
5. **Agent-initiated calls.** The agent can ring any family member to deliver task results, reminders, messages. Per-user config.

## What it doesn't do

No SMS. No web browser. No maps. No contact list. No tethering. No keypad. No text input. No Bluetooth accessories. No app store. No screen.

## Input: one button, four gestures

State-dependent behaviour on a single physical button:

- **Single press, idle** → dial spouse
- **Double press, idle** → dial child
- **Long press, idle** → record audio to agent; release to send
- **Any press, ringing** → answer
- **Any press, in call** → hang up

Single/double/hold is reliably distinguishable by feel. Feedback channels: one status LED (cord scar), vibration motor, short audio tones through the earpiece.

## Form factor

Modelled on the handpiece of an early-80s home telephone. ~200×40×35mm, gentle curve, speaker at one end and mic at the other, button on the concave inside where fingers fall naturally. Same chassis for every family member, different colour.

Material: plastic or wood, not metal (metal blocks antennas). A turned walnut handset with brass button bezels is the aesthetic target; a 3D-printed PLA prototype is fine for v0.

Internal volume is generous enough for a 3000–5000 mAh battery, two well-placed antennas (cellular + GNSS), real earpiece and mic drivers, and a chunky tactile button with deep travel.

## Architecture

Three layers:

- **Clients**: hardware handsets, PWAs. Each is a unique device identity in the directory.
- **Home server** (Pi): directory, auth, signalling, audio relay, admin page, location sink, voicemail store. Single source of truth.
- **Agent**: AJT's long-running Claude instance, hosted in eal as the `eal agent` worker. Shows up in the directory as a contact. Only knows what AJT tells it.

### Audio relay over WebSockets (no media server)

For ~5 clients, a full media server (LiveKit, Asterisk) is overkill. Simpler design:

- Each client holds one persistent WebSocket to the home server.
- To place a call, client sends a signalling message. Server pushes "incoming" to the target device(s).
- Once connected, each side streams Opus audio frames up the WebSocket. Server forwards to the other side.
- N-way calls: server mixes streams. Trivial at this scale.
- NAT/STUN/TURN: not needed. WebSockets over TLS punch through anything.
- Latency cost vs peer-to-peer: ~10–20ms. Inaudible.
- Call quality: Opus + small jitter buffer + (for handsets) modem's analog echo cancellation.

### Tech stack

- **Runtime**: Bun
- **Server framework**: Elysia
- **Data**: SQLite + Litestream continuous backup to cheap object storage
- **Clients**: Preact + signals, as PWAs (installable, offline-capable)
- **Transport**: WebSockets over TLS for everything (signalling, audio, presence)
- **TLS ingress**: Tailscale Funnel. Only the Pi is on the tailnet (one device, one user — free Personal tier). Funnel publishes it at a `*.ts.net` address with an auto-renewing Let's Encrypt cert. Clients connect to that URL like any public website; they don't need Tailscale installed.
- **Handset firmware**: separate concern. ESP32-S3 + cellular modem. See Hardware sketch.

Rationale: AJT is already comfortable with this stack, it's fast to iterate in, and it covers every layer of the system with one language (TypeScript) and one runtime (Bun). The handset is the only part that breaks out of this; everything else is one codebase.

### Identity and sign-in

- Each device (handset, PWA install, agent) is its own directory entry with a burned-in device token.
- Adding a new PWA install: a trusted device speaks a short one-time code through its earpiece, user types or speaks it back into the PWA, server matches and issues a token.
- Same voice-code pattern can gate sensitive agent actions later ("say 'yes, do it'").
- Codes are single-use, 60s TTL, rate-limited per human.

### Web admin page

A single page at `family.local/admin` on the Pi, sections:

- **Humans**: name, role, colour, notes.
- **Devices**: per-human list. Revokable.
- **Call matrix**: grid of who-can-call-whom (humans × humans, including the agent as a row and column). Click to toggle.
- **Ring rules**: which device(s) ring when someone calls a human.
- **Agent proactivity**: rules for when the agent is allowed to ring unprompted.
- **DND**: global override.
- **Activity log**: rolling tail of recent calls and agent events.

Small Elysia API backed by SQLite. No analytics, no dashboards.

### Redundancy (future)

AJT has two houses. Natural topology is one Pi per house, primary/hot-standby with automatic failover via a tiny €3 VPS acting as bootstrap ("which Pi is live right now"). Litestream replicates SQLite between them via object storage. Not needed for v0.

## Hardware sketch (handset)

Not a BOM yet:

- **Cellular + GNSS module**: SIMCom A7608E-H (LTE Cat-4, EMEA bands, with GNSS). Primary use is 4G data for the WebSocket audio relay.
- **MCU**: ESP32-S3-WROOM-1.
- **Breadboard platform for v0**: LilyGO T-A7608X-S3 (ESP32-S3 + A7608E-H on one PCB). Already in hand. LilyGO's example repo for this board is vendored at `vendor/LilyGo-Modem-Series/`; the PlatformIO env is `T-A7608X-S3`.
- **Audio**: analog earpiece + mic path through the modem's codec for echo cancellation and noise suppression. MCU handles Opus encode/decode and streams over WebSocket.
- **Power**: 3000–5000 mAh LiPo + TP4056 charge controller. Target multi-day standby.
- **Antennas**: external for prototyping, internal once the enclosure is designed.
- **Indicator**: one LED in the cord scar.

### VoLTE is out of scope

The handset uses its cellular modem only for 4G *data*. All voice — family calls, agent, inbound PSTN — goes over the WebSocket audio relay. VoLTE (the carrier-certified voice path over LTE) is explicitly not supported.

Why: VoLTE on hobbyist modem modules in Italy is a certification and carrier-quirks minefield that has killed similar projects. Avoiding it entirely removes the biggest single risk from the build.

Future: if VoLTE support in mainstream modules gets meaningfully easier (better carrier whitelisting, better open-source IMS stacks, better module firmware), it could be added later as a fallback path for receiving PSTN calls when the server is unreachable. Not planned.

## Phased plan

Each phase is shippable on its own. If the project stops at any point, you still have a working thing.

0. **Cellular de-risk.** LilyGO T-A7608X-S3 in hand. Put a TIM SIM in it, flash LilyGO's `ATdebug` example via PlatformIO (env `T-A7608X-S3`), confirm the modem registers and signal is healthy. Then flash an HTTPS example and prove a 200 over 4G data.

   *Status (2026-05-25):* done at the Bologna flat. Modem registers on TIM, LTE band 3, RSSI 26/31. APN `ibox.tim.it`. `HttpsBuiltlnGet` returns 200 from `httpbin.org` and `vsh.pp.ua`. Egress IP visible as 95.75.48.0 (TIM CGNAT). Coverage at the hills house is assumed and will be spot-checked on the next visit; not a blocker for later phases.
1. **Server skeleton.** Pi set up. Bun + Elysia hello world. SQLite schema for humans, devices, tokens. Litestream backup to cheap object storage. Tailscale Funnel for TLS ingress. Accessible from outside the home network.
2. **WebSocket audio relay.** Elysia WebSocket endpoint. Connection registry. Tiny signalling protocol (`call`, `accept`, `reject`, `hangup`). Opus frame forwarding. Test rig: two raw browser tabs streaming audio to each other via the server. No UI.
3. **First PWA.** Preact + signals. Device token auth. Mic capture, speaker playback, Opus encode/decode. Contact list from the server. Tap-to-call. Persistent WebSocket with ring-on-incoming. Deliverable: laptop can call phone browser and hold a real conversation.
4. **Directory and admin page.** Humans and devices CRUD. Spoken-code sign-in flow for adding new devices. Admin page with human management and call matrix. Call matrix enforced server-side.
5. **Agent as a contact.** Extend the existing `eal agent` worker to take voice as well as text: Whisper for transcription on the way in, Claude for thinking, TTS for reply on the way out. Agent is a directory entry you can call like anyone else. Structured-markdown memory, shared with the worker's existing text surface. Narrow tool surface added to the claude-runner: `place_call`, `send_voice_message`.
6. **Agent-initiated calls and proactivity.** Scheduler. Per-user rules. "Message pending" state in PWAs.

   *Status (2026-05-27):* done. A new `agent` API sub-app carries the rule table, an action audit log, and a per-device phone lock. The eal agent worker's scheduler ticks every 30 s (overridable via `EAL_SCHEDULER_TICK_MS` for tests), picks up due rules, claims the lock through the action handler, and either dials the target over its own family-phone WS (place_call) or synthesises via the configured TtsProvider and POSTs to a new `family_phone_voice_messages` table (voice_message). A new `place_call` MCP tool feeds the same path from a user-prompted chat. The household PWA gains a `/agent-rules` panel for rule CRUD plus the activity log, and the family-phone panel gains a voicemails card with per-message playback and a "new" badge. The server's call state machine now has an explicit `call:unanswered` event so unanswered rings collapse cleanly. `scripts/e2e-agent-voice-call.ts --scheduled` exercises the full path end-to-end against a real worker subprocess.
7. **PSTN via trunk.** Twilio Programmable Voice number, inbound and outbound. Bridge into the signalling layer as a virtual device — to the relay it's a contact like any other, to Twilio the api is a regular WS Media Streams consumer.

   *Plan (2026-06-01):*

   ```
   PSTN ↔ Twilio ↔ webhook + WS Media Stream ↔ api ↔ family-phone relay ↔ handsets
   ```

   Each inbound or outbound call materialises a row in `family_phone_devices` with `kind='pstn'` and the remote E.164 as its label; the existing call state machine then drives the conversation unchanged. Inbound calls fan out a `placeCall` to every handset and the first to accept wins (others get `call:cancelled`). Codec gap: Twilio Media Streams carry G.711 μ-law 8 kHz; the relay carries 24 kHz PCM. A bridge module decodes/resamples in both directions.

   Required env vars: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`. With `TWILIO_ENABLED=true` and any missing, the api refuses to boot — no silent disable. An optional `TWILIO_CALLER_ID` overrides the outbound `From` and defaults to `TWILIO_PHONE_NUMBER` (see the AGCOM note below). Webhook authenticity is verified against the `X-Twilio-Signature` header, which Twilio's classic scheme signs with the auth token — there is no separate webhook signing key.

   **Italy / AGCOM caller-ID constraint.** Italy's AGCOM anti-spoofing filter (2025) blocks any internationally-routed call that presents an Italian caller ID — geographic CLI from 19 Aug 2025, mobile CLI from 19 Nov 2025. Twilio is a foreign carrier, so a Twilio-originated call *into* Italy bearing an Italian number as `From` is dropped at the recipient's operator, and Twilio's own guidance offers no whitelist workaround. Inbound is unaffected — the Italian DID only ever *receives* — but outbound to Italian numbers must present a non-Italian caller ID. The trunk therefore splits the two: `TWILIO_PHONE_NUMBER` is the inbound DID; the optional `TWILIO_CALLER_ID` (defaulting to the DID) is the outbound `From`. For an Italian household: keep an Italian DID for inbound, set `TWILIO_CALLER_ID` to a non-Italian number for outbound — the call rings, the recipient just sees a foreign number. 7C's dial-pad and any agent-initiated PSTN call into Italy depend on this; verify outbound separately from inbound.

   Sub-phases, each shippable and each with a committed verification script under `scripts/`:

   - **7A** — `pstn_contacts` table + migration; admin UI to add/edit/delete a number with a friendly label; CLI seed. No Twilio yet.
   - **7B** — Twilio inbound: webhook handler at `/api/family-phone/twilio/voice` returns TwiML with `<Stream>`; WS handler `/twilio/media` decodes G.711 μ-law base64 frames; codec module (pcmu↔pcm, 8↔24 kHz resample); virtual-device bridge fans out the invite, first-accept-wins. `scripts/e2e-pstn-inbound.ts` mocks the Twilio media stream and a real handset; audio round-trips.
   - **7C** — Twilio outbound: dial-pad UI (350 px keypad), REST POST to `Calls.json` with a stable TwiML URL, media WS in the reverse direction, sharing 7B's bridge. `scripts/e2e-pstn-outbound.ts`.
   - **7D** — Abuse defaults: 30 s no-answer → voicemail via the existing `family_phone_voice_messages` inbox (the virtual PSTN device is the `fromDeviceId`); per-source-number rate limit in a new `pstn_calls` table; webhook HMAC-SHA1 signature verification.
   - **7E** — Production wire-up: buy the number, point the webhook at the Tailscale Funnel URL, set `TWILIO_CALLER_ID` to a non-Italian number if the DID is Italian (AGCOM, above), real-phone smoke test of inbound *and* outbound.

   Provider tradeoff: Twilio is ~$0.0085/min inbound + $1/number/month — fine for one household phone. A SIP trunk (Voxbone/Anveo) is ~3-5× cheaper but needs Asterisk on the Pi; revisit when there are multiple numbers.

8. **GPS sink.** Browser geolocation from PWAs. Location table. Map view in admin.
9. **Handset firmware.** ESP32-S3 + A7608E-H. Cellular data, WebSocket client, Opus I/O, button gestures, LED state machine. The handset becomes another client, indistinguishable from a PWA to the server.
10. **Enclosure and ergonomics.** Product design.
11. **Later.** Second and third handsets. Cradles. Two-Pi redundancy.

## Bring-up notes

What's known about working on the board, captured as we go.

- **Toolchain.** PlatformIO Core (CLI) installed via the official installer into `~/.platformio/penv/`, with `pio` symlinked into `~/.local/bin/`. No Arduino IDE, no Homebrew.
- **Vendored upstream.** LilyGO's `LilyGo-Modem-Series` repo lives at `vendor/LilyGo-Modem-Series/`. Two edits to its `platformio.ini`: `default_envs = T-A7608X-S3`, and `src_dir` pointed at whichever example we're flashing.
- **APN.** TIM data APN is `ibox.tim.it`. The LilyGO HTTPS examples leave `NETWORK_APN` undefined, which auto-attaches but then fails HTTP with `+HTTPACTION: <n>,714,0` ("network not opened"). Always set the APN explicitly before any HTTP work.
- **Serial port.** The ESP32-S3 native USB-JTAG enumerates as `/dev/cu.usbmodem101` (VID:PID `303A:1001`). No external USB-UART adapter needed.
- **Driving the board non-interactively.** `scripts/serial_capture.py` opens the port, optionally sends a list of AT-style lines with CRLF, and streams output for a fixed window. Used in place of an interactive `pio device monitor` so the dev loop is: flash → capture → read → edit → repeat, without a human in the loop. Example: `python scripts/serial_capture.py --port /dev/cu.usbmodem101 --seconds 30 --send "AT" --send "AT+CSQ"`.
- **Interactive monitor (when a human is at the keyboard).** `pio device monitor -p /dev/cu.usbmodem101 -b 115200 --echo --eol CRLF --filter send_on_enter`. The defaults (no echo, no line buffering) feel broken.
- **Reset vs boot.** Two tactile buttons near the USB-C. `RST` reboots and re-runs the sketch; `BOOT` only matters when held during reset (download mode). The ATdebug sketch waits 5 seconds at boot for the serial console to attach, so give it ~6 s before typing.

## Agent boundary

Agent and family-phone share a process and a repo, but not a trust boundary. The `eal agent` worker is AJT's long-running Claude instance; family-phone is one of its clients, not its owner. Keep the seam between them honest even though both live in eal.

- Agent has **narrow tools** into family-phone: `place_call(contact)`, `send_voice_message(contact, audio)`. Nothing else. The tools go through the family-phone HTTP/WS API like any other client, not through in-process shortcuts.
- Agent does **not** have raw database access to the family directory, call history, or locations. It only knows what AJT tells it.
- Agent memory lives in structured markdown notes (same pattern as AJT's existing memory system). Human-readable and editable.
- Agent is reachable from other surfaces too — the eal web app today, terminal and Claude Code tomorrow. family-phone is one interface, not the only one.

## Deferred questions

- **Cradles.** One per home, Wi-Fi, charge + detect dock + ring loudly + physical DND switch + voicemail when handset is docked. Not v0.
- **Agent proactivity policy.** Concrete defaults for when agent rings vs queues a message.
- **Ring style.** Vibration only / + tone / + spoken "call from X".
- **Battery target.** Every-night charging vs multi-day.
- **Provisioning model** for handsets (burned-in device token, almost certainly).
- **Son's agent access.** Disabled now, unlockable later with per-age tool scope.

## Still open

- Exact button placement and tactile shape
- Authentication and key storage on the ESP32
- What the agent's initial tool surface looks like
- Whether spouse/son handsets are built at the same time or AJT's first
