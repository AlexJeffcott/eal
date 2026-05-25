# family-phone

A hobbyist-built wireless handset and PWA system that lets AJT's family (AJT, spouse, 9-year-old son) call each other and a personal agent over a self-hosted service. Designed for AJT, based in Italy.

Family-phone lives inside eal as a sub-app (`packages/api/src/apps/family-phone.ts`) sharing eal's identity, deploy, and runtime infrastructure. Handset firmware and the LilyGO bring-up scripts remain in the standalone `~/projects/family-phone/` repo — see its README for hardware notes.

## What it is

A private family communication system with two kinds of client:

- **Custom wireless handsets** shaped like the handpiece of an early-80s telephone. One per family member. One physical button on the inside curve. No screen. Runs on cellular data.
- **PWAs** for laptops and phones, so family members without a handset (or away from it) can still participate.

All clients talk to a small self-hosted server (Pi at home) that routes calls, manages identity, and exposes a directory and admin page.

The agent is a separate project (AJT's long-running personal Claude instance) that shows up in family-phone's directory as just another contact.

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
- **Agent** (separate project): AJT's long-running Claude instance. Shows up in the directory as a contact. Only knows what AJT tells it.

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
5. **Agent as a contact.** Small adapter process on the Pi. Whisper for transcription, Claude for thinking, TTS for reply. Agent is a directory entry you can call like anyone else. Structured-markdown memory. Narrow tool surface: `place_call`, `send_voice_message`.
6. **Agent-initiated calls and proactivity.** Scheduler. Per-user rules. "Message pending" state in PWAs.
7. **PSTN inbound via trunk.** Twilio or Voxbone number. Bridge into the signalling layer as another contact.
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

Agent is a *separate project* — AJT's long-running Claude instance — with its own repo, memory, and tools. family-phone is a client of the agent, not an owner of it.

- Agent has **narrow tools** into family-phone: `place_call(contact)`, `send_voice_message(contact, audio)`. Nothing else.
- Agent does **not** have raw database access to the family directory, call history, or locations. It only knows what AJT tells it.
- Agent memory lives in structured markdown notes (same pattern as AJT's existing memory system). Human-readable and editable.
- Agent is reachable from other surfaces too (terminal, Claude Code) — family-phone is one interface, not the only one.

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
