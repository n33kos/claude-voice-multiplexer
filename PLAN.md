# Claude Voice Relay

Route voicemode audio I/O from a MacBook to an iPhone over the local network, using LiveKit as a real-time audio transport layer.

## Status

| Phase | Status | Notes |
|-------|--------|-------|
| Research & Architecture | Done | All findings documented below |
| Token Server + Web Client | Done | `token-server.py` + `client/index.html` |
| Toggle Script | Done | `relay start/stop/status` |
| LiveKit Server Install | Done | `brew install livekit` (v1.9.11) |
| Voicemode LiveKit Extras | Done | `uv tool install voice-mode[livekit]` (livekit-agents 1.3.12) |
| voicemode.env Config | Done | `LIVEKIT_URL=ws://localhost:7880` (localhost due to CrowdStrike) |
| Smoke Test (infra) | Done | LiveKit + token server start, health checks, JWT generation all verified |
| End-to-End Test | Done | Working via ngrok tunnel (CrowdStrike blocks LAN) |
| Bug Fixes | Not Started | See Known Bugs section below |
| Internet Access | Future | See Future Features section below |

## Architecture

```
iPhone (Safari)                Mac (all processing stays here)
┌─────────────────┐           ┌──────────────────────────────────────┐
│                 │           │                                      │
│  Web Client     │◄─WebRTC──►  LiveKit Server (:7880)              │
│  (mic/speaker)  │           │       │                              │
│                 │           │       ▼                              │
│  served from    │◄─HTTP────►  Token Server (:3100)                │
│  :3100          │           │                                      │
│                 │           │  Voicemode (LiveKit transport)       │
└─────────────────┘           │       │              │               │
                              │  Whisper (:2022)  Kokoro (:8880)    │
                              │  (STT)            (TTS)              │
                              │                                      │
                              │  Claude Code (session)               │
                              └──────────────────────────────────────┘
```

**Audio flow:**
1. iPhone mic -> WebRTC -> LiveKit room -> voicemode subscribes to audio track
2. Voicemode sends audio to Whisper (local STT) -> transcription text
3. Claude Code processes the text, generates response
4. Response text -> Kokoro (local TTS) -> audio
5. Voicemode publishes audio track to LiveKit room -> WebRTC -> iPhone speaker

**Key insight:** LiveKit is ONLY the audio transport. All STT, LLM, and TTS processing stays on the Mac. No cloud services involved.

## Toggle Mechanism

Voicemode's `transport` parameter has three modes: `auto`, `local`, `livekit`.

With `transport="auto"` (the default), voicemode calls `check_livekit_available()` on each `converse()` call, which:
1. Checks if the `livekit` Python package is installed
2. Connects to the LiveKit server API
3. Lists rooms and checks for rooms with `num_participants > 0`
4. Returns `True` only if there's an active room with a participant

**This means the toggle is automatic:**
- **No one has the web client open** -> auto selects `local` (direct Mac mic)
- **iPhone has the web client connected** -> auto selects `livekit` (remote audio)

The only infrastructure toggle is starting/stopping the LiveKit server and token server. The `relay` script handles this:
- `relay start` -> starts LiveKit + token server, prints iPhone URL
- `relay stop` -> stops both, voicemode seamlessly falls back to local mic
- `relay status` -> shows what's running

**Performance note:** When LiveKit server is NOT running, `check_livekit_available()` may add ~1-2s of connection timeout on each `converse()` call. For best local-mode performance, stop the LiveKit server when not using remote mode.

## Research Findings

### Voicemode's Existing LiveKit Support

Voicemode (v7.4.2) already has full LiveKit support:

- **Transport code:** `voice_mode/tools/converse.py` lines 966-1143
- **LiveKit Agents SDK:** Uses `livekit.agents` with a `VoiceAgent` subclass
- **Auto-detection:** `check_livekit_available()` checks for rooms with participants
- **STT/TTS routing:** Uses `livekit.plugins.openai` to create TTS/STT clients pointed at local Whisper/Kokoro endpoints
- **Bundled frontend:** Complete Next.js app at `voice_mode/frontend/` with production build

### Bugs Found in Bundled Frontend

Two issues prevent us from using the bundled frontend directly:

1. **Hardcoded LIVEKIT_URL** (`frontend/app/api/connection-details/route.ts` line 8):
   ```typescript
   const LIVEKIT_URL = "wss://x1:8443"; // process.env.LIVEKIT_URL || "ws://localhost:7880";
   ```
   The env var read is commented out and replaced with a hardcoded URL (`wss://x1:8443`). This is baked into the production build.

2. **Dummy token in production Python server** (`tools/livekit/production_server.py` line 177):
   ```python
   "participantToken": "dummy-token",  # Would generate real token
   ```
   The Python fallback server doesn't generate real LiveKit JWT tokens.

**POC approach:** Build a custom lightweight token server + web client to bypass both issues. This also gives us full control over LAN binding and configuration.

### Environment & Configuration

Current state:
- Whisper: running on port 2022 (Core ML, Metal GPU)
- Kokoro: running on port 8880
- LiveKit server: NOT installed
- LiveKit Python extras: NOT installed (need `voice-mode[livekit]`)
- Mac LAN IP: `192.168.4.146` (may change with DHCP)
- Config file: `~/.voicemode/voicemode.env`

Default LiveKit config (already in voicemode.env, just commented out):
```
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
VOICEMODE_FRONTEND_HOST=127.0.0.1
VOICEMODE_FRONTEND_PORT=3000
```

### Key Source Files

| File | Purpose |
|------|---------|
| `~/.local/share/uv/tools/voice-mode/.../tools/converse.py` | Main converse tool, LiveKit transport at lines 966-1143 |
| `~/.local/share/uv/tools/voice-mode/.../config.py` | All config including LiveKit env vars (lines 556-591) |
| `~/.local/share/uv/tools/voice-mode/.../tools/livekit/install.py` | LiveKit server install logic (brew on macOS) |
| `~/.local/share/uv/tools/voice-mode/.../tools/livekit/frontend.py` | Frontend management (start/stop/status) |
| `~/.local/share/uv/tools/voice-mode/.../tools/livekit/production_server.py` | Python HTTP server (has dummy token bug) |
| `~/.voicemode/voicemode.env` | User's voicemode configuration |

## Implementation Plan

### Phase 1: Infrastructure Setup

- [x] Install LiveKit server: `brew install livekit` (v1.9.11)
- [x] Install voicemode LiveKit extras: `uv tool install voice-mode[livekit]`
- [x] Verify LiveKit server starts: `livekit-server --dev --bind 0.0.0.0`
- [x] Update `~/.voicemode/voicemode.env`:
  - Set `LIVEKIT_URL=ws://192.168.4.146:7880`
  - Set `LIVEKIT_API_KEY=devkey`
  - Set `LIVEKIT_API_SECRET=secret`

### Phase 2: Token Server + Web Client (this repo)

**Token server** (`token-server.py`):
- Python HTTP server binding to `0.0.0.0:3100`
- `GET /` -> serves the web client HTML
- `GET /token?room=<name>&identity=<name>` -> returns LiveKit JWT
- Uses `livekit-api` Python package for token generation
- Reads `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` from env (defaults to devkey/secret)

**Web client** (`client/index.html`):
- Single HTML file, LiveKit JS SDK loaded from CDN
- Password prompt (matches `LIVEKIT_ACCESS_PASSWORD`)
- Connects to LiveKit room, publishes mic, subscribes to audio
- Mobile-responsive for iPhone Safari
- Shows connection status and audio visualizer

### Phase 3: Toggle Script

**`relay` script:**
- `relay start` -> starts LiveKit server (background) + token server (background), detects LAN IP, prints iPhone URL
- `relay stop` -> kills both processes, voicemode auto-falls back to local
- `relay status` -> shows PID, ports, LAN URL
- Stores PIDs in `~/.voicemode/relay.pid` for clean shutdown

### Phase 4: End-to-End Testing

1. Start relay: `./relay start`
2. Open printed URL on iPhone Safari
3. Enter password, tap "Start Conversation"
4. In Claude Code: test voicemode `converse()` — should auto-detect LiveKit
5. Verify: speech from iPhone -> transcription -> Claude response -> TTS plays on iPhone
6. Stop relay: `./relay stop`
7. Verify: voicemode falls back to local Mac mic seamlessly

### Phase 5: Bug Fixes

- [ ] Fix audio visualizer bars (not animating)
- [ ] Fix "agent disconnected" flicker between turns
- [ ] Add turn-taking chimes to phone client
- [ ] Handle long speech input / 120s timeout gracefully
- [ ] Investigate audio dropout on long TTS responses

### Phase 6 (Future): Enhancements

- [ ] Text I/O display on phone client
- [ ] Self-hosted cloud relay (personal web server)
- [ ] Explore alternative tunnel methods (Tailscale, Cloudflare, LiveKit Cloud)
- [ ] Multi-agent session switching (see below)

## Future Features

## Known Bugs

### 1. Audio visualizer bars don't move
The frequency visualizer in the web client never animates — bars stay flat during both mic input and agent audio playback. Likely the `setupAudioAnalyser()` isn't receiving the audio stream correctly, or the analyser isn't connected to the right source nodes.

### 2. "Agent disconnected" flicker between turns
When voicemode finishes a converse call, it leaves the LiveKit room. The phone client shows "Agent disconnected" briefly before the next converse call joins again. Need either: (a) persistent agent presence in the room, or (b) client-side UX that masks the gap (e.g. "Thinking..." state instead of "Agent disconnected").

### 3. No audio chimes on the phone to indicate turn-taking
The user has no way to know when the system is listening vs processing. Voicemode has built-in chimes for local mode, but they don't route through LiveKit to the phone. Need to either: (a) route voicemode's chime audio through LiveKit, or (b) play chimes client-side triggered by LiveKit events (agent join = listening, agent publish audio = responding).

### 4. Long speech input causes timeout / audio loss
The voicemode `converse()` call has a `listen_duration_max` of 120s. If the user speaks for a long time, the listen window expires and the audio may not be fully captured. Need to: (a) ensure a stop chime plays when listen time runs out, (b) ensure all captured audio still gets routed to Whisper/Claude even on timeout, (c) consider whether the limit should be extended or made configurable for relay mode.

### 5. Voicemode missing `TTS_BASE_URLS` import (fixed)
`converse.py` was missing `TTS_BASE_URLS` in its import from `voice_mode.config`, causing LiveKit transport to fail. Fixed by adding the import — but this is a patch on the installed package that will be lost on voicemode updates.

## Known Limitations

### CrowdStrike Falcon blocks LAN connections
CrowdStrike endpoint security on the Mac blocks all inbound TCP connections on non-loopback interfaces. This prevents direct LAN access (phone → Mac IP). Current workaround: ngrok tunnel. See debugging notes in git history.

### ngrok free tier constraints
- URLs change every session (no stable address)
- Added latency routing through ngrok relay servers
- Free tier has connection/bandwidth limits
- Requires ngrok account + authtoken

## Future Features

### Text I/O display on phone client
Add a live transcript/status feed to the web client showing:
- What the user said (STT result)
- Processing state ("Thinking...", "Generating response...")
- Claude's response text
- Possibly a scrollable conversation history

### Self-hosted cloud relay
Host the relay application on a personal web server for stable internet access without ngrok limitations. Architecture would be:
- Web server hosts the token server + web client (publicly accessible)
- LiveKit server runs on the web server (or use LiveKit Cloud)
- Voicemode on Mac connects to the remote LiveKit server
- Phone connects to the web-hosted client
- Eliminates need for ngrok, Tailscale, or LAN access

### Multi-agent session switching
Support multiple concurrent Claude Code sessions, each registered as a separate agent. The phone web UI would show a list of active sessions and let the user:
- See which Claude sessions are running and available for voice
- Switch between sessions (connect voice to a different agent)
- Connect/disconnect voicemode per session independently
- Potentially talk to one session while others continue working in the background

This would require:
- A session registry (token server or separate service tracks which Claude sessions have registered as agents)
- Each Claude Code instance registers itself with a name/label when relay is active
- Web client UI for listing sessions and switching between them
- LiveKit room-per-session or room switching logic
- Graceful handoff (disconnect voice from session A, connect to session B)

**Key architectural challenge:** Voicemode is pull-based — Claude must actively call `converse()` which blocks waiting for audio. There's no persistent listener. For multi-agent switching, the target session needs to be actively listening when the user wants to speak to it.

Potential approaches:
1. **Push model (daemon)**: A lightweight service on the Mac that persistently listens on LiveKit rooms and dispatches audio to the correct Claude session via IPC (pipe, socket, or webhook). Claude sessions register with the daemon and receive transcribed text or raw audio on demand.
2. **Agent-initiated polling**: Each Claude session periodically calls `converse()` with a short timeout, checking if there's audio waiting in its assigned room. The web UI signals which room is "active" so only one session picks up audio at a time.
3. **LiveKit Agents SDK as standalone bridge**: Skip voicemode's converse wrapper entirely. Run a persistent livekit-agents service that handles STT/TTS and communicates with Claude sessions through a separate channel (e.g. Claude API directly, or stdin/stdout pipes to Claude Code processes).

### Alternative tunnel/access methods
- **Tailscale**: Stable IPs, low latency, requires install on both devices
- **Cloudflare Tunnel**: Free, no account needed for quick tunnels
- **LiveKit Cloud**: Free tier (10k min/month), removes need to self-host LiveKit server
- **Self-hosted relay**: See above

## Configuration Changes Reference

### voicemode.env changes for remote mode

```bash
# Uncomment and set these in ~/.voicemode/voicemode.env
LIVEKIT_URL=ws://192.168.4.146:7880    # Use Mac's LAN IP
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

Note: The LIVEKIT_URL must use the LAN IP (not localhost) so the iPhone can reach it. For voicemode's local transport, this setting is ignored (it doesn't connect to LiveKit when using local mic).

### Installing LiveKit extras

```bash
# This adds livekit, livekit-agents, livekit-plugins-openai, silero-vad
uv tool install voice-mode[livekit]
```

After install, restart Claude Code so voicemode picks up the new packages.

## Quick Start (after setup)

```bash
# 1. Start the relay
cd ~/claude-voice-relay
./relay start

# 2. Open the printed URL on your iPhone in Safari
#    Enter the password (default: voicemode123)
#    Tap "Start Conversation"

# 3. Use Claude Code normally - voicemode auto-detects the remote connection

# 4. When done, stop the relay
./relay stop
# Voicemode seamlessly falls back to local Mac mic
```

## Project Structure

```
~/claude-voice-relay/
├── PLAN.md              # This file - architecture, findings, plan
├── relay                # Toggle script: start/stop/status
├── token-server.py      # Python HTTP server: serves client + generates LiveKit tokens
├── client/
│   └── index.html       # LiveKit web client for iPhone Safari
└── .gitignore
```

## Setup Checklist (first time only)

- [x] `brew install livekit` — Installed v1.9.11
- [x] `uv tool install voice-mode[livekit]` — Installed livekit-agents 1.3.12 + 27 deps
- [x] Update `~/.voicemode/voicemode.env` — Set `LIVEKIT_URL=ws://localhost:7880`
- [x] `./relay start` — Both servers start, health checks pass, JWT generation verified
- [x] Restart Claude Code — So voicemode picks up new livekit packages
- [x] Fix `TTS_BASE_URLS` missing import in voicemode `converse.py`
- [x] Discover CrowdStrike blocks LAN — set up ngrok dual tunnel as workaround
- [x] Open URL on iPhone — Web client loads and connects via ngrok
- [x] Test end-to-end — Voice relay working: phone mic → LiveKit → Whisper → Claude → Kokoro → LiveKit → phone speaker
