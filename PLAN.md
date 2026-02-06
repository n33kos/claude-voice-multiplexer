# Claude Voice Relay

Route voicemode audio I/O from a MacBook to an iPhone over the local network, using LiveKit as a real-time audio transport layer.

## Status

| Phase | Status | Notes |
|-------|--------|-------|
| Research & Architecture | Done | All findings documented below |
| Token Server + Web Client | Done | `token-server.py` + `client/index.html` |
| Toggle Script | Done | `relay start/stop/status` |
| LiveKit Server Install | Not Started | `brew install livekit` |
| Voicemode LiveKit Extras | Not Started | `uv tool install voice-mode[livekit]` |
| voicemode.env Config | Not Started | Uncomment LiveKit env vars |
| End-to-End Test | Not Started | iPhone Safari -> Mac -> Claude Code |
| Internet Access (Tailscale) | Future | Out of scope for POC |

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

- [ ] Install LiveKit server: `brew install livekit`
- [ ] Install voicemode LiveKit extras: `uv tool install voice-mode[livekit]`
- [ ] Verify LiveKit server starts: `livekit-server --dev --bind 0.0.0.0`
- [ ] Update `~/.voicemode/voicemode.env`:
  - Uncomment and set `LIVEKIT_URL=ws://<LAN_IP>:7880`
  - Uncomment `LIVEKIT_API_KEY=devkey`
  - Uncomment `LIVEKIT_API_SECRET=secret`

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

### Phase 5 (Future): Internet Access

- Install Tailscale on Mac and iPhone
- Replace LAN IP with Tailscale IP in LIVEKIT_URL
- Everything else stays the same
- Alternative: LiveKit Cloud free tier (10k min/month) for zero-config internet access

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

- [ ] `brew install livekit` — Install LiveKit server
- [ ] `uv tool install voice-mode[livekit]` — Add LiveKit extras to voicemode
- [ ] Update `~/.voicemode/voicemode.env` — Uncomment LiveKit env vars (see config section above)
- [ ] Restart Claude Code — So voicemode picks up new packages
- [ ] `./relay start` — Verify both servers start cleanly
- [ ] Open URL on iPhone — Test the web client loads
- [ ] Test end-to-end — Voicemode `converse()` should auto-detect LiveKit transport
