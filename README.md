# Claude Voice Multiplexer

A Claude Code MCP plugin and relay server for remote voice interaction with multiple Claude Code sessions. Talk to your running Claude sessions from anywhere — switch between them, see their output, and control them by voice from your phone or any browser.

## Architecture

```
Phone / Browser                    Mac (all local)
┌──────────────────────┐          ┌──────────────────────────────────────────┐
│                      │          │                                          │
│  React Web App       │◄─LiveKit─►  Relay Server (:3100)                  │
│  (mic/speaker/UI)    │  WebRTC  │  ├── LiveKit Agent (embedded)           │
│                      │          │  │   ├── VAD + audio buffering          │
│  Features:           │          │  │   ├── Whisper STT                    │
│  - Voice I/O         │          │  │   └── Kokoro TTS                     │
│  - Session list      │          │  ├── WebSocket hub                      │
│  - Session switching │          │  ├── Session registry                   │
│  - Text transcript   │          │  └── LiveKit token server               │
│  - Agent status      │          │                                          │
│  - Activity display  │          │  Claude Code Sessions (iTerm2)           │
│                      │          │  ├── Session A ← MCP plugin (standby)   │
└──────────────────────┘          │  ├── Session B ← MCP plugin (standby)   │
                                  │  └── Session C ← MCP plugin (standby)   │
                                  └──────────────────────────────────────────┘

For remote access: expose relay server via tunnel (Cloudflare/ngrok/Tailscale)
```

## How It Works

### Session Registration (MCP Plugin)

Each Claude Code session has the MCP plugin installed. When the user invokes a standby skill, the plugin:

1. Connects to the relay server via WebSocket and registers (session name, working directory, metadata)
2. Sends periodic heartbeats to maintain presence in the session registry
3. Listens for incoming voice messages (transcribed text from the relay)
4. When a voice message arrives: delivers the text to Claude, Claude processes it, and sends the conversational response back to the relay
5. The relay synthesizes the response with Kokoro and streams audio back to the client

### Audio Flow

```
Phone mic → LiveKit (WebRTC) → Relay Server (LiveKit Agent)
  → VAD detects end-of-speech
  → Whisper (local STT) → transcribed text
  → WebSocket → MCP plugin in Claude session
  → Claude processes, generates response text
  → WebSocket → Relay Server
  → Kokoro (local TTS) → PCM audio
  → LiveKit (WebRTC) → Phone speaker
```

### Agent Status Framework

The agent tracks its state as a structured status object with both a state and an optional activity label:

```
{state: "thinking", activity: "Transcribing speech..."}
{state: "speaking", activity: null}
{state: "idle", activity: null}
{state: "error", activity: "Speech-to-text failed. Is Whisper running?"}
```

**States:**

| State      | Description           | Mic                        | Activity Label             |
| ---------- | --------------------- | -------------------------- | -------------------------- |
| `idle`     | Ready for voice input | Respects user's mic toggle | n/a                        |
| `thinking` | Claude is working     | Disabled                   | Shows what Claude is doing |
| `speaking` | TTS audio playing     | Disabled                   | n/a                        |
| `error`    | Service failure       | Disabled                   | Shows error message        |

**Status signal flow:**

```
Claude calls relay_activity("Reading files...")
  → MCP sends {type: "status_update", activity: "Reading files..."}
    → Relay server forwards to agent
      → Agent updates status, notifies web client
        → Web UI shows "Reading files..." under the voice bar

Claude calls relay_respond(text)
  → Agent status → speaking
    → TTS plays
      → Agent status → thinking (activity: "Waiting for Claude...")
        → Claude calls relay_standby()
          → MCP sends {type: "listening"}
            → Agent status → idle
```

Error states auto-recover to idle after 5 seconds. A 15-second thinking timeout prevents permanent stuck states if Claude is interrupted before calling `relay_standby`.

### Input Gating

To prevent overlapping messages, the microphone is disabled during Claude's turn:

1. After an utterance is sent to Claude → agent enters `thinking` state (audio input ignored)
2. When Claude responds → agent enters `speaking` state (TTS plays, audio still ignored)
3. After TTS finishes → agent stays in `thinking` with "Waiting for Claude..." until Claude calls `relay_standby`
4. When Claude calls `relay_standby` → agent enters `idle` (mic respects user's toggle preference)

The idle state does **not** auto-enable the microphone. If the user has manually muted, idle simply waits. The interrupt button (visible during thinking/error states) forces a transition to idle.

### Session Switching

The web UI shows all registered Claude sessions. The user taps to switch. The relay disconnects voice from the current session and connects to the selected one. Sessions not actively connected still maintain heartbeat.

## Components

### 1. MCP Plugin (`mcp-server/`)

A lightweight MCP server (FastMCP) that adds voice relay tools to any Claude Code session.

**Tools:**

| Tool               | Description                                                                     |
| ------------------ | ------------------------------------------------------------------------------- |
| `relay_standby`    | Register and enter standby mode. Blocks until a voice message arrives.          |
| `relay_respond`    | Send Claude's response text back to the relay for TTS synthesis.                |
| `relay_activity`   | Update the web client with Claude's current activity (e.g. "Reading files..."). |
| `relay_disconnect` | Unregister from the relay and exit standby mode.                                |
| `relay_status`     | Show current relay connection status.                                           |

The MCP plugin only deals in text. All audio processing happens in the relay server.

**Key files:**

- `mcp-server/server.py` — FastMCP server with all tools, WebSocket connection management, heartbeat, and message queue

### 2. Relay Server (`relay-server/`)

A Python server (FastAPI + Uvicorn) that bridges the web client, Claude sessions, and local AI services.

**Responsibilities:**

- **Session registry** (`registry.py`): Track which Claude sessions are in standby, with heartbeat-based timeout
- **LiveKit agent** (`livekit_agent.py`): Embedded agent that joins the LiveKit room, handles VAD, STT, TTS, and the agent status state machine
- **Audio pipeline** (`audio.py`): HTTP clients for Whisper (STT) and Kokoro (TTS) with PCM support
- **Configuration** (`config.py`): All env-var-driven settings with sensible defaults
- **WebSocket hub** (`server.py`): Manages connections to both MCP plugins and web clients
- **Token generation**: Issues LiveKit JWTs for client authentication

**Endpoints:**

| Endpoint            | Type      | Description                                                      |
| ------------------- | --------- | ---------------------------------------------------------------- |
| `GET /`             | HTTP      | Serve the React web app (from `web/dist/`)                       |
| `GET /api/sessions` | HTTP      | List all registered Claude sessions                              |
| `GET /api/token`    | HTTP      | Generate LiveKit JWT for client connection                       |
| `WS /ws/session`    | WebSocket | MCP plugin registration, voice text relay, status updates        |
| `WS /ws/client`     | WebSocket | Web client events (session switching, transcripts, agent status) |

**WebSocket protocol — `/ws/session` (MCP plugin):**

| Direction       | Message Type    | Description                                     |
| --------------- | --------------- | ----------------------------------------------- |
| Plugin → Server | `register`      | Register session with name, cwd, metadata       |
| Server → Plugin | `registered`    | Acknowledgment                                  |
| Plugin → Server | `heartbeat`     | Keep-alive with timestamp                       |
| Plugin → Server | `response`      | Claude's text response for TTS                  |
| Plugin → Server | `listening`     | Claude is ready for next voice input            |
| Plugin → Server | `status_update` | Activity label update (e.g. "Reading files...") |
| Server → Plugin | `voice_message` | Transcribed voice text from user                |

**WebSocket protocol — `/ws/client` (web app):**

| Direction       | Message Type         | Description                                  |
| --------------- | -------------------- | -------------------------------------------- |
| Client → Server | `connect_session`    | Switch to a session                          |
| Client → Server | `disconnect_session` | Disconnect from current session              |
| Client → Server | `interrupt`          | Force agent to idle                          |
| Server → Client | `sessions`           | Full session list update                     |
| Server → Client | `session_connected`  | Session switch confirmed                     |
| Server → Client | `agent_status`       | Agent state + activity label + timestamp     |
| Server → Client | `transcript`         | Transcript entry (speaker, text, session_id) |

### 3. React Web App (`web/`)

A static-built React app served by the relay server. Mobile-first design for phone use.

**Features:**

- Session list with connect/disconnect
- Voice bar visualizer with real audio data (from mic and remote TTS track)
- Mic toggle that respects agent state (disabled during thinking/speaking/error)
- Activity label display (shows what Claude is doing)
- Interrupt button (visible during thinking/error states)
- Audio chimes on state transitions (ascending for ready, descending for captured)
- Live transcript (user + Claude + system messages)
- Connection status bar

**Key files:**

| File                           | Description                                                          |
| ------------------------------ | -------------------------------------------------------------------- |
| `App.tsx`                      | Root component, wires hooks to components                            |
| `hooks/useRelay.ts`            | WebSocket state management, `AgentStatus` interface, reconnect logic |
| `hooks/useLiveKit.ts`          | LiveKit token fetching and connection state                          |
| `hooks/useChime.ts`            | Audio feedback chimes on state transitions                           |
| `components/VoiceControls.tsx` | LiveKit room, mic controls, audio analysers, interrupt button        |
| `components/VoiceBar.tsx`      | Canvas-based audio visualizer with per-state colors and animations   |
| `components/SessionList.tsx`   | Session list with connect/disconnect buttons                         |
| `components/Transcript.tsx`    | Scrolling transcript display                                         |
| `components/StatusBar.tsx`     | Connection status indicators                                         |

**Tech stack:** React 19, Vite 7, LiveKit React SDK, TailwindCSS v4, TypeScript

### 4. Skills (`skills/`)

Claude Code skill definitions that invoke the MCP tools in a conversational loop.

| Skill              | Description                                                      |
| ------------------ | ---------------------------------------------------------------- |
| `relay-standby`    | Enter standby mode with conversation loop and activity reporting |
| `relay-disconnect` | Disconnect from voice relay                                      |
| `relay-status`     | Show relay connection status                                     |

### 5. Infrastructure

**Local services (managed separately via voice-mode CLI):**

- **Whisper server** — Local STT (configurable via `WHISPER_URL`, default `:8100`)
- **Kokoro server** — Local TTS (configurable via `KOKORO_URL`, default `:8101`)
- **LiveKit server** — WebRTC audio transport (auto-started by `scripts/start.sh` on `:7880`)

**This project's services:**

- **Relay server** on `:3100` — started via `scripts/start.sh`
- **MCP server** — started automatically by Claude Code via the plugin system
- **Vite dev server** on `:5173` — optional, started when `DEV_MODE=true`

## Configuration

All settings are configured via environment variables. Use a `.env` file at the project root. See `.env.example` for the full list.

**Key settings:**

| Variable                | Default                    | Description                                                   |
| ----------------------- | -------------------------- | ------------------------------------------------------------- |
| `RELAY_HOST`            | `0.0.0.0`                  | Relay server bind address                                     |
| `RELAY_PORT`            | `3100`                     | Relay server port                                             |
| `WHISPER_URL`           | `http://127.0.0.1:8100/v1` | Whisper STT endpoint                                          |
| `KOKORO_URL`            | `http://127.0.0.1:8101/v1` | Kokoro TTS endpoint                                           |
| `KOKORO_VOICE`          | `af_default`               | TTS voice (supports blends like `am_adam(0.3)+hm_omega(0.7)`) |
| `LIVEKIT_URL`           | `ws://localhost:7880`      | LiveKit server URL                                            |
| `LIVEKIT_API_KEY`       |                            | LiveKit API key                                               |
| `LIVEKIT_API_SECRET`    |                            | LiveKit API secret                                            |
| `LIVEKIT_ROOM`          | `voice_relay`              | LiveKit room name                                             |
| `SESSION_TIMEOUT`       | `60`                       | Session heartbeat timeout (seconds)                           |
| `VAD_AGGRESSIVENESS`    | `1`                        | VAD sensitivity (0=permissive, 3=strict)                      |
| `SILENCE_THRESHOLD_MS`  | `2000`                     | Silence duration before utterance ends                        |
| `MIN_SPEECH_DURATION_S` | `0.5`                      | Minimum speech before silence can end utterance               |
| `ECHO_COOLDOWN_S`       | `0.8`                      | Seconds to ignore mic after TTS (echo suppression)            |
| `ENERGY_THRESHOLD`      | `500`                      | Energy threshold for fallback VAD                             |
| `DEV_MODE`              | `false`                    | Start Vite dev server alongside relay server                  |

## Getting Started

### Prerequisites

- macOS with Homebrew
- Python 3.11+ with `uv`
- Node.js 20+ with npm
- Whisper and Kokoro running (via `voice-mode` CLI or manually)
- LiveKit server (`brew install livekit`)

### Loading the Plugin

Add a shell alias to load the plugin on every `claude` invocation:

```bash
alias claude='command claude --plugin-dir /path/to/claude-voice-multiplexer'
```

This gives every Claude session access to the MCP tools and the `/voice-multiplexer:relay-standby` skill.

### Running the Relay Server

```bash
# Production: serves built web app from web/dist
./scripts/start.sh

# Development: also starts Vite dev server with HMR
./scripts/start.sh --dev
# Or set DEV_MODE=true in .env
```

The start script will:

1. Load `.env` configuration
2. Check if Whisper and Kokoro are running
3. Start LiveKit server if not already running
4. Start the relay server
5. Optionally start the Vite dev server

### Building the Web App

```bash
cd web
npm install
npm run build   # Production build → dist/ (served by relay server)
```

### Using Voice Mode

1. Start the relay server: `./scripts/start.sh`
2. In any Claude Code session, invoke: `/voice-multiplexer:relay-standby`
3. Open `http://localhost:3100` (or `:5173` in dev mode) on your phone
4. Tap a session to connect, enable mic, and start talking

## Project Structure

```
claude-voice-multiplexer/
├── .claude-plugin/
│   └── plugin.json                      # Plugin manifest
├── .mcp.json                            # Bundled MCP server definition
├── .env                                 # Local configuration (gitignored)
├── .env.example                         # Configuration reference
├── README.md                            # This file
├── skills/
│   ├── relay-standby/SKILL.md           # Standby skill with conversation loop
│   ├── relay-disconnect/SKILL.md        # Disconnect skill
│   └── relay-status/SKILL.md            # Status skill
├── mcp-server/
│   ├── server.py                        # FastMCP server with relay tools
│   └── requirements.txt
├── relay-server/
│   ├── server.py                        # Main server (FastAPI + WebSocket hub)
│   ├── livekit_agent.py                 # LiveKit agent (VAD, audio I/O, status state machine)
│   ├── audio.py                         # Whisper/Kokoro HTTP clients
│   ├── registry.py                      # Session registry with heartbeat timeout
│   ├── config.py                        # Configuration (env vars + .env)
│   └── requirements.txt
├── web/
│   ├── src/
│   │   ├── App.tsx                      # Root component
│   │   ├── main.tsx                     # Entry point
│   │   ├── index.css                    # Tailwind imports
│   │   ├── components/
│   │   │   ├── SessionList.tsx          # Session list with connect/disconnect
│   │   │   ├── VoiceControls.tsx        # LiveKit room, mic, audio analysers
│   │   │   ├── VoiceBar.tsx             # Canvas audio visualizer
│   │   │   ├── Transcript.tsx           # Scrolling transcript
│   │   │   └── StatusBar.tsx            # Connection status
│   │   └── hooks/
│   │       ├── useRelay.ts              # WebSocket state, AgentStatus
│   │       ├── useLiveKit.ts            # LiveKit token + connection
│   │       └── useChime.ts              # Audio feedback chimes
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
└── scripts/
    └── start.sh                         # Start all services
```

## Bugs

Known issues to investigate and fix:

- **Chimes arent woring**: Audio chimes for state transitions (ready/captured) don't play.
- **Voice bar remote track**: The VoiceBar should show real audio visualization for the speaking state using the remote agent's audio track, but `useTracks` may not always return the remote track depending on LiveKit subscription timing.
- **Session participant mapping**: The agent currently finds sessions by looking for the first session with a connected client (`_find_session_for_participant`). This is a naive heuristic that breaks with multiple simultaneous clients.
- **No WAV header validation**: The `_to_wav` helper builds WAV manually but there's no validation that the resulting bytes are well-formed. Edge cases (empty buffer, very short utterances) may produce malformed audio.
- **Whisper blank filtering**: The `BLANK_PATTERNS` set catches common Whisper noise artifacts but may miss others (language-specific blanks, model-dependent artifacts).
- **TTS playback timing jitter**: The `+0.5s` jitter buffer in `_publish_audio` is a rough heuristic. LiveKit's `capture_frame` pacing varies, so remaining playback calculation may over- or under-sleep.

## To Do

### High Priority

- [ ] **Multiple simultaneous clients**: Map participant identity → client_id → session properly instead of naive first-match
- [ ] **Authentication**: Add auth to the web app (JWT or session-based) to prevent unauthorized access
- [ ] **Error recovery UX**: When Whisper or Kokoro goes down, show persistent error with retry button instead of transient auto-recover
- [ ] **Reconnect handling**: When MCP plugin WebSocket drops and reconnects, restore session state cleanly

### Medium Priority

- [ ] **Voice commands for session switching**: "Switch to project X" should work via voice
- [ ] **Persistent conversation history**: Store transcripts across sessions/reconnects
- [ ] **Session metadata display**: Show working directory, session age, last activity in the session list
- [ ] **Push-to-talk mode**: Alternative to open mic — hold button to speak, release to send
- [ ] **Audio level indicator**: Show input volume meter so user knows mic is picking up audio before VAD triggers

### Low Priority / Future

- [ ] **Streaming TTS**: Stream Kokoro output chunks to LiveKit as they're generated instead of waiting for full synthesis
- [ ] **Streaming STT**: Use streaming Whisper for real-time partial transcriptions
- [ ] **Multi-room LiveKit**: Separate LiveKit rooms per session for true multi-client support
- [ ] **Theme customization**: Light/dark mode toggle, custom accent colors
- [ ] **Keyboard shortcuts**: Desktop web client keyboard shortcuts for mic toggle, interrupt, session switching
- [ ] **Tunnel integration**: Built-in Cloudflare/ngrok tunnel setup for remote access
