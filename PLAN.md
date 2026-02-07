# Claude Voice Multiplexer

A Claude Code MCP plugin and relay server for remote voice interaction with multiple Claude Code sessions. Talk to your running Claude sessions from anywhere — switch between them, see their output, and control them by voice from your phone or any browser.

## Architecture

```
Phone / Browser                    Mac
┌──────────────────────┐          ┌──────────────────────────────────────────┐
│                      │          │                                          │
│  React Web App       │◄─LiveKit─►  Relay Server                           │
│  (mic/speaker/UI)    │  WebRTC  │  ├── LiveKit Server (:7880)             │
│                      │          │  ├── Token Server (:3100)               │
│  Features:           │          │  ├── Session Registry                   │
│  - Voice I/O         │          │  │   (tracks active Claude sessions)    │
│  - Session list      │          │  ├── Whisper Client (:2022)             │
│  - Session switching │          │  └── Kokoro Client (:8880)              │
│  - Text transcript   │          │                                          │
│                      │          │  Claude Code Sessions (iTerm2)           │
└──────────────────────┘          │  ├── Session A ← MCP plugin (standby)   │
                                  │  ├── Session B ← MCP plugin (standby)   │
                                  │  └── Session C ← MCP plugin (standby)   │
                                  └──────────────────────────────────────────┘
```

## How It Works

### Session Registration (MCP Plugin)

Each Claude Code session has the MCP plugin installed. When the user invokes a standby skill or command, the plugin:

1. Registers with the relay server via HTTP (session name, working directory, metadata)
2. Sends periodic heartbeats to maintain presence in the session registry
3. Opens a WebSocket to the relay server to receive incoming voice messages
4. When a voice message arrives: receives the transcribed text, lets Claude process it, and sends Claude's conversational text response back to the relay
5. The relay synthesizes the response with Kokoro and streams audio back to the client

### Audio Flow

```
Phone mic → LiveKit (WebRTC) → Relay Server
  → Whisper (local STT, :2022) → transcribed text
  → WebSocket → MCP plugin in Claude session
  → Claude processes, generates response text
  → WebSocket → Relay Server
  → Kokoro (local TTS, :8880) → audio
  → LiveKit (WebRTC) → Phone speaker
```

### Session Switching

The web UI shows all registered Claude sessions. The user taps to switch. The relay:

1. Disconnects voice from current session
2. Connects voice to the selected session
3. Audio now routes to/from the new session

Sessions not actively connected still maintain heartbeat and can receive voice at any time.

## Components

### 1. MCP Plugin (`claude-voice-multiplex` MCP server)

A lightweight MCP server that adds voice relay capabilities to any Claude Code session.

**Tools provided:**
- `relay_standby` — Register this session with the relay server and enter standby mode. Session becomes available for remote voice. Maintains heartbeat. Receives transcribed voice input, returns Claude's conversational response.
- `relay_disconnect` — Unregister from the relay and exit standby mode.
- `relay_status` — Show current relay connection status.

**Behavior in standby:**
- The plugin opens a persistent WebSocket connection to the relay server
- Sends heartbeat every ~15 seconds with session metadata
- When voice input arrives (as transcribed text), it's injected into Claude's context
- Claude's response is captured and sent back through the WebSocket
- The user can Ctrl+C or type to exit standby and resume normal use

**Key design decision:** The MCP plugin does NOT handle audio. It only deals in text. Audio capture/playback happens entirely in the relay server using Whisper and Kokoro. This keeps the plugin simple and avoids any audio dependency in Claude Code sessions.

**Code to cannibalize from Voice Mode:**
- Config pattern: env file loading, cascading config (`voice_mode/config.py`)
- Conch-style lock mechanism for coordinating which session has the "floor" (`voice_mode/conch.py`)
- Session metadata patterns from agent system (`voice_mode/cli_commands/agent.py`)

### 2. Relay Server

A Python server that bridges the web client, Claude sessions, and local AI services.

**Responsibilities:**
- **Session registry**: Track which Claude sessions are in standby, their names, metadata
- **Audio transport**: Manage LiveKit rooms for WebRTC audio with phone clients
- **STT pipeline**: Receive audio from LiveKit → transcribe with Whisper → send text to Claude session
- **TTS pipeline**: Receive text response from Claude session → synthesize with Kokoro → stream audio to LiveKit
- **Token generation**: Issue LiveKit JWTs for client authentication
- **WebSocket hub**: Manage connections to MCP plugins in Claude sessions

**Endpoints:**
- `GET /` — Serve the React web app
- `GET /api/token` — Generate LiveKit JWT for client connection
- `GET /api/sessions` — List all registered Claude sessions
- `WS /ws/session` — WebSocket for MCP plugin registration + voice text relay
- `WS /ws/client` — WebSocket for web client events (session switching, status)

**Code to cannibalize from Voice Mode:**
- Whisper client integration (`voice_mode/core.py` — STT HTTP calls)
- Kokoro client integration (`voice_mode/core.py` — TTS HTTP calls with streaming)
- Audio format handling and compression (`voice_mode/config.py` — format configs)
- VAD / silence detection logic (`voice_mode/tools/converse.py` — WebRTC VAD, silence thresholds)
- Streaming audio playback patterns (`voice_mode/streaming.py` — buffer management)
- LiveKit token generation (`voice_mode/tools/livekit/` — JWT creation)

### 3. React Web App

A static-built React app served by the relay server. Mobile-first design for phone use.

**Features:**
- **Session list**: Shows all active Claude sessions with name, directory, status
- **Session switching**: Tap to connect voice to a different session
- **Voice controls**: Push-to-talk or voice-activated, mute/unmute
- **Live transcript**: Shows the conversation (what you said, what Claude said)
- **Audio visualizer**: Visual feedback during speech
- **Connection status**: LiveKit connection state, relay heartbeat

**Tech stack:**
- React (Vite build)
- LiveKit React SDK for WebRTC audio
- TailwindCSS for styling
- Built as static files, served by relay server

### 4. Infrastructure

**Services (already running, shared with Voice Mode):**
- Whisper server on `:2022` — local STT
- Kokoro server on `:8880` — local TTS
- LiveKit server on `:7880` — WebRTC audio transport

**New services:**
- Relay server on `:3100` — orchestrates everything
- Serves the web app, handles session registry, bridges audio and text

**Network access:**
- CrowdStrike blocks LAN on this Mac, so ngrok or Tailscale needed for phone access
- Alternatively: run relay server on a cloud host (see Deployment Modes below)

## Deployment Modes

### Mode 1: Fully Local (starting point)

Everything runs on the Mac. Phone accesses via ngrok tunnel.

```
Phone → ngrok → Relay Server (Mac :3100) → Whisper/Kokoro/LiveKit (Mac)
                     ↕ WebSocket
              MCP Plugins (Mac, Claude Code sessions)
```

### Mode 2: Hybrid Cloud (target)

Relay server runs on a personal web server with a public URL. Whisper and Kokoro stay on the Mac for GPU inference. MCP plugins connect to the remote relay.

```
Phone → Relay Server (web server, public URL)
              ↕ WebSocket (internet)          ↕ HTTP (internet)
  MCP Plugins (Mac, Claude Code)     Whisper/Kokoro (Mac, local)
```

In this mode:
- The relay server calls back to the Mac for STT/TTS (Whisper and Kokoro endpoints need to be reachable — via Tailscale, reverse tunnel, or similar)
- The MCP plugin WebSocket connects outbound to the relay server (no inbound port needed on Mac)
- Phone hits the public relay URL directly — no ngrok required
- Audio quality benefits from Kokoro running on Mac GPU

### Mode 3: Fully Cloud (future option)

Everything runs on the web server, including Whisper and Kokoro. No dependency on the Mac being online except for the Claude Code sessions themselves.

```
Phone → Relay Server (web server) → Whisper/Kokoro (web server)
              ↕ WebSocket
  MCP Plugins (Mac, Claude Code)
```

## Cleanup: Remove POC Files

The following files are leftovers from the initial proof-of-concept and are no longer used by the new architecture. Delete them:

- `client/` — Old vanilla JS web client (replaced by upcoming React web app in `web/`)
  - `client/app.js`
  - `client/index.html`
  - `client/styles.css`
- `token-server.py` — Old standalone HTTP token server (replaced by `relay-server/server.py`)
- `mcp-server/.venv/` — Temporary venv from testing (deps now handled by `uv run`)

## Implementation Plan

### Phase 1: MCP Plugin Skeleton — Done

- [x] Create MCP server using FastMCP (Python)
- [x] Implement `relay_standby` tool — connects to relay via WebSocket, sends heartbeat
- [x] Implement `relay_respond` tool — sends text response back for TTS synthesis
- [x] Implement `relay_disconnect` tool — clean shutdown
- [x] Implement `relay_status` tool — show connection state
- [x] Test: WebSocket registration, ack, heartbeat, disconnect cleanup — all verified

### Phase 2: Relay Server Core — Done

- [x] Set up Python server (FastAPI + uvicorn)
- [x] Implement session registry (in-memory, with heartbeat timeout and stale pruning)
- [x] Implement WebSocket hub for MCP plugin connections (`/ws/session`)
- [x] Implement WebSocket hub for web clients (`/ws/client`)
- [x] Implement token endpoint for LiveKit JWTs (`/api/token`, uses livekit-api builder pattern)
- [x] Implement sessions API endpoint (`/api/sessions`)
- [x] Implement session-to-client text relay (response → transcript + TTS)
- [x] Implement client-to-session voice relay (voice_input → transcribe → forward)
- [x] Implement session list broadcast to all connected clients on changes
- [x] Test: 13/13 integration tests passing — registration, session list, client switching, text relay, disconnect notification, multi-session

### Phase 3: Audio Pipeline

- [x] Integrate Whisper client for STT (relay-server/audio.py)
- [x] Integrate Kokoro client for TTS (relay-server/audio.py)
- [ ] Implement LiveKit audio receive → Whisper transcription pipeline
- [ ] Implement Kokoro TTS → LiveKit audio publish pipeline
- [ ] Implement VAD / silence detection for turn-taking (cannibalize from Voice Mode)
- [ ] Wire up: phone audio → transcription → Claude session → TTS → phone audio
- [ ] Test: end-to-end voice loop with a single session

### Phase 4: React Web App

- [ ] Scaffold React app with Vite + TailwindCSS
- [ ] Integrate LiveKit React SDK for audio
- [ ] Build session list component (fetches from /api/sessions)
- [ ] Build session switching UI
- [ ] Build voice controls (mute, push-to-talk toggle)
- [ ] Build live transcript view
- [ ] Build connection status indicator
- [ ] Static build, configure relay server to serve it
- [ ] Test: full UI on phone via ngrok

### Phase 5: Polish & Multi-Session

- [ ] Session naming and metadata display
- [ ] Graceful session disconnect/reconnect handling
- [ ] Audio chimes for turn-taking (client-side)
- [ ] Error handling and recovery (WebSocket reconnect, service failures)
- [ ] Multiple simultaneous standby sessions with clean switching
- [ ] Test: switch between 2-3 active Claude sessions by voice

### Phase 6: Future Enhancements

- [ ] Cloud-hosted relay for true remote access (no ngrok)
- [ ] Authentication for the web app (pin code, passkey, etc.)
- [ ] iOS PWA support (home screen app, push notifications)
- [ ] Voice commands for session switching ("switch to project X")
- [ ] Persistent conversation history across sessions
- [ ] Agent-to-agent messaging (tell one Claude about another's output)

## Voice Mode Codebase Reference

Key files to cannibalize from the Voice Mode package at:
`~/.local/share/uv/tools/voice-mode/lib/python3.14/site-packages/voice_mode/`

| File | What to take |
|------|-------------|
| `core.py` | Whisper STT client, Kokoro TTS client, streaming audio, OpenAI-compatible API patterns |
| `streaming.py` | Audio stream buffering, TTFA tracking, progressive playback |
| `config.py` | Env file loading, audio format config, service port defaults |
| `conch.py` | File-based lock mechanism for multi-session coordination |
| `tools/converse.py` | VAD silence detection, recording state machine, audio compression for STT |
| `cli_commands/agent.py` | Session metadata patterns, heartbeat approach, multi-agent discovery |
| `serve_middleware.py` | ASGI middleware patterns (IP allowlist, token auth) |
| `simple_failover.py` | Provider failover/retry logic for TTS and STT |

## Project Structure

This project is a **Claude Code plugin** that bundles an MCP server, skills, and a relay server in one package.

```
claude-voice-multiplexer/                # Claude Code plugin root
├── .claude-plugin/
│   └── plugin.json                      # Plugin manifest
├── .mcp.json                            # Bundled MCP server definition
├── skills/
│   └── relay-standby/
│       └── SKILL.md                     # /voice-multiplexer:relay-standby skill
├── PLAN.md                              # This file
├── mcp-server/                          # MCP server (bundled in plugin)
│   ├── server.py                        # FastMCP server with relay tools
│   ├── config.py                        # Plugin configuration
│   └── requirements.txt
├── relay-server/                        # Relay server (standalone process)
│   ├── server.py                        # Main server (FastAPI)
│   ├── registry.py                      # Session registry
│   ├── audio.py                         # Whisper/Kokoro/LiveKit audio pipeline
│   ├── config.py                        # Server configuration
│   └── requirements.txt
├── web/                                 # React web app
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── SessionList.tsx
│   │   │   ├── VoiceControls.tsx
│   │   │   ├── Transcript.tsx
│   │   │   └── StatusBar.tsx
│   │   └── hooks/
│   │       ├── useLiveKit.ts
│   │       └── useRelay.ts
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   └── tailwind.config.ts
└── scripts/
    └── start.sh                         # Start all services
```

## Configuration

### Relay Server Config

```bash
# Environment variables (or in a .env file in relay/)
RELAY_PORT=3100
RELAY_HOST=0.0.0.0
WHISPER_URL=http://127.0.0.1:2022/v1
KOKORO_URL=http://127.0.0.1:8880/v1
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

## Development Setup

### Loading the Plugin (no publishing required)

A shell alias in `~/.zshrc` automatically loads the plugin on every `claude` invocation:

```bash
alias claude='command claude --plugin-dir /Users/nicholassuski/claude-voice-multiplexer --plugin-dir /Users/nicholassuski/claude-plugins/plugins/learn'
```

This gives every Claude session access to:
- The MCP server (tools: `relay_standby`, `relay_disconnect`, `relay_status`)
- The skill (`/voice-multiplexer:relay-standby`)

No manual MCP configuration or publishing needed. Restart Claude to pick up plugin changes.

### Running the Relay Server (development)

```bash
cd ~/claude-voice-multiplexer/relay-server
python server.py
```

### Building the Web App (development)

```bash
cd ~/claude-voice-multiplexer/web
npm install
npm run dev     # Vite dev server with hot reload
npm run build   # Production build → dist/ (served by relay server)
```
