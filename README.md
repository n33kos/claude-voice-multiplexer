# Claude Voice Multiplexer

A Claude Code MCP plugin and relay server for remote voice interaction with multiple Claude Code sessions. Talk to your running Claude sessions from anywhere — switch between them, see their output, and control them by voice from your phone or any browser.

## Architecture

```
Phone / Browser                    Mac (all local)
┌──────────────────────┐          ┌──────────────────────────────────────────┐
│                      │          │                                          │
│  React Web App       │◄─LiveKit─►  Relay Server (:3100)                    │
│  (mic/speaker/UI)    │  WebRTC  │  ├── LiveKit Agent (embedded)            │
│                      │          │  │   ├── VAD + audio buffering           │
│  Features:           │          │  │   ├── Whisper STT                     │
│  - Voice I/O         │          │  │   └── Kokoro TTS                      │
│  - Session list      │          │  ├── WebSocket hub                       │
│  - Session switching │          │  ├── Session registry                    │
│  - Text transcript   │          │  └── LiveKit token server                │
│  - Agent status      │          │                                          │
│  - Activity display  │          │  Claude Code Sessions (iTerm2)           │
│                      │          │  ├── Session A ← MCP plugin (standby)    │
└──────────────────────┘          │  ├── Session B ← MCP plugin (standby)    │
                                  │  └── Session C ← MCP plugin (standby)    │
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

The idle state respects the user's auto-listen preference. If auto-listen is enabled (mic button active), idle auto-enables the microphone. If disabled, idle simply waits. The interrupt button (visible during thinking/speaking/error states) forces a transition to idle.

### Session Switching

The web UI shows all registered Claude sessions. The user taps to switch. The relay disconnects voice from the current session and connects to the selected one. Sessions not actively connected still maintain heartbeat.

## Components

### 1. MCP Plugin (`mcp-server/`)

A lightweight MCP server (FastMCP) that adds voice relay tools to any Claude Code session.

**Tools:**

| Tool                 | Description                                                                     |
| -------------------- | ------------------------------------------------------------------------------- |
| `relay_standby`      | Register and enter standby mode. Blocks until a voice message arrives.          |
| `relay_respond`      | Send Claude's response text back to the relay for TTS synthesis.                |
| `relay_activity`     | Update the web client with Claude's current activity (e.g. "Reading files..."). |
| `relay_disconnect`   | Unregister from the relay and exit standby mode.                                |
| `relay_status`       | Show current relay connection status.                                           |
| `generate_auth_code` | Generate a 6-digit pairing code for authorizing a new device.                   |

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
- **Authentication** (`auth.py`): Device pairing with JWT tokens, pairing codes, and device management
- **WebSocket hub** (`server.py`): Manages connections to both MCP plugins and web clients
- **Token generation**: Issues LiveKit JWTs for client authentication
- **LiveKit proxy**: Proxies WebSocket and HTTP traffic to the local LiveKit server, enabling single-port remote access

**Endpoints:**

| Endpoint                        | Type      | Description                                                |
| ------------------------------- | --------- | ---------------------------------------------------------- |
| `GET /`                         | HTTP      | Serve the React web app (from `web/dist/`)                 |
| `GET /api/sessions`             | HTTP      | List all registered Claude sessions (auth required)        |
| `GET /api/token`                | HTTP      | Generate LiveKit JWT for client connection (auth required)  |
| `GET /api/health`               | HTTP      | Service health check (Whisper, Kokoro, LiveKit, relay)     |
| `WS /livekit/{path}`            | WebSocket | Proxy to local LiveKit server (for remote/tunnel access)   |
| `GET /livekit/{path}`           | HTTP      | HTTP proxy to local LiveKit server                         |
| `GET /api/auth/status`          | HTTP      | Check if the current client is authenticated               |
| `POST /api/auth/pair`           | HTTP      | Pair a new device using a one-time code                    |
| `POST /api/auth/code`           | HTTP      | Generate a pairing code (auth required)                    |
| `GET /api/auth/devices`         | HTTP      | List all authorized devices (auth required)                |
| `DELETE /api/auth/devices/{id}` | HTTP      | Revoke a device's authorization (auth required)            |
| `WS /ws/session`                | WebSocket | MCP plugin registration, voice text relay, status updates  |
| `WS /ws/client`                 | WebSocket | Web client events (auth required on handshake)             |

**WebSocket protocol — `/ws/session` (MCP plugin):**

| Direction       | Message Type    | Description                                     |
| --------------- | --------------- | ----------------------------------------------- |
| Plugin → Server | `register`      | Register session with name, cwd, metadata       |
| Server → Plugin | `registered`    | Acknowledgment                                  |
| Plugin → Server | `heartbeat`     | Keep-alive with timestamp                       |
| Plugin → Server | `response`      | Claude's text response for TTS                  |
| Plugin → Server | `listening`     | Claude is ready for next voice input            |
| Plugin → Server | `status_update` | Activity label update (e.g. "Reading files...") |
| Plugin → Server | `generate_code` | Request a device pairing code                   |
| Server → Plugin | `voice_message` | Transcribed voice text from user                |
| Server → Plugin | `auth_code`     | Generated pairing code response                 |

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

- Collapsible session drawer with session cards, dropdown menus, and online/offline status
- Persistent sessions in IndexedDB (survive disconnects and page reloads)
- Voice bar visualizer with real audio data (voice-optimized frequency mapping)
- Mic toggle with auto-listen mode (mic auto-enables when agent goes idle)
- Speaker mute button for silencing TTS playback
- Activity label display (shows what Claude is doing in real time)
- Activity entries persisted inline in the transcript
- Interrupt button (visible during thinking/speaking/error states)
- Audio chimes on state transitions (ascending for ready, descending for captured)
- Live transcript with IndexedDB persistence (keyed by session name)
- Settings panel (theme selector, auto-listen toggle, speaker mute, device management)
- Light/dark mode with system preference detection (three-option: System/Light/Dark)
- Device authentication with pairing codes and JWT tokens
- Connection status bar (Relay Server / LiveKit Audio / Claude indicators)
- Animated rainbow gradient header

**Key files:**

| File                          | Description                                                                |
| ----------------------------- | -------------------------------------------------------------------------- |
| `App.tsx`                     | Root component, wires hooks to components                                  |
| `hooks/useRelay.ts`           | WebSocket state, `AgentStatus`, persistent sessions, transcript management |
| `hooks/useLiveKit.ts`         | LiveKit token fetching and connection state                                |
| `hooks/useChime.ts`           | Audio feedback chimes on state transitions                                 |
| `hooks/useSettings.ts`        | localStorage-backed settings (theme, auto-listen, speaker mute)            |
| `hooks/useTheme.ts`           | Theme application (system preference detection, data-theme attribute)      |
| `hooks/useAuth.ts`            | Auth state, device pairing, device management API                          |
| `hooks/useTranscriptDB.ts`    | IndexedDB persistence for transcripts and sessions                         |
| `components/VoiceControls/`   | LiveKit room, mic/speaker/interrupt controls, audio analysers              |
| `components/VoiceBar/`        | Canvas audio visualizer with voice-optimized frequency mapping             |
| `components/SessionList/`     | Collapsible session drawer with dropdown menus                             |
| `components/Transcript/`      | Scrolling transcript with activity entries                                 |
| `components/StatusBar/`       | Connection status indicators (Relay Server / LiveKit / Claude)             |
| `components/PairScreen/`      | Device pairing code entry screen                                           |
| `components/Settings/`        | Settings panel (theme, auto-listen, speaker mute, device management)       |
| `components/Header/`          | Animated rainbow gradient header with settings button                      |
| `components/ParticleNetwork/` | Background particle animation canvas                                       |

Components use a folder-based architecture with co-located `.module.scss` stylesheets, `.types.d.ts` type definitions, and sub-components in nested `components/` directories.

**Tech stack:** React 19, Vite 7, LiveKit React SDK, CSS Modules + SCSS (with CSS custom property theming), TypeScript

### 4. Skills (`skills/`)

Claude Code skill definitions that invoke the MCP tools and service scripts.

| Skill            | Description                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `standby`        | Enter standby mode with conversation loop and activity reporting |
| `start-services` | Start all services (auto-installs on first use)                  |
| `stop-services`  | Stop all running Voice Multiplexer services                      |
| `service-status` | Check the status of all services                                 |
| `auth-code`      | Generate a device pairing code for the web app                   |

The `standby` skill automatically checks if services are installed and running, handling first-time setup and startup before entering standby mode.

### 5. Infrastructure

All services are self-contained and managed by `scripts/start.sh`:

| Service             | Port    | Description                                                  |
| ------------------- | ------- | ------------------------------------------------------------ |
| **Whisper server**  | `:8100` | Local STT (whisper.cpp, compiled from source with Metal GPU) |
| **Kokoro server**   | `:8101` | Local TTS (kokoro-fastapi, PyTorch with MPS acceleration)    |
| **LiveKit server**  | `:7880` | WebRTC media server for audio transport                      |
| **Relay server**    | `:3100` | The core hub (FastAPI + WebSocket)                           |
| **MCP server**      | —       | Started automatically by Claude Code via the plugin system   |
| **Vite dev server** | `:5173` | Optional, started when `DEV_MODE=true`                       |

Whisper and Kokoro are installed to `~/.claude/voice-multiplexer/` by the install script and started/stopped alongside the other services.

## Configuration

All settings are configured via `~/.claude/voice-multiplexer/voice-multiplexer.env`, which is generated by the install script with all available options documented inline.

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
| `SESSION_TIMEOUT`       | `120`                      | Session heartbeat timeout (seconds)                           |
| `VAD_AGGRESSIVENESS`    | `1`                        | VAD sensitivity (0=permissive, 3=strict)                      |
| `SILENCE_THRESHOLD_MS`  | `2000`                     | Silence duration before utterance ends                        |
| `MIN_SPEECH_DURATION_S` | `0.5`                      | Minimum speech before silence can end utterance               |
| `ECHO_COOLDOWN_S`       | `0.8`                      | Seconds to ignore mic after TTS (echo suppression)            |
| `ENERGY_THRESHOLD`      | `500`                      | Energy threshold for fallback VAD                             |
| `MAX_RECORDING_S`       | `180`                      | Max recording duration in seconds (3 minutes)                 |
| `DEV_MODE`              | `false`                    | Start Vite dev server alongside relay server                  |
| `VMUX_WHISPER_PORT`     | `8100`                     | Whisper server listen port                                    |
| `VMUX_WHISPER_MODEL`    | `base`                     | Whisper model name (base, small, medium, large)               |
| `VMUX_WHISPER_THREADS`  | `auto`                     | Whisper inference threads (auto = CPU count)                  |
| `VMUX_KOKORO_PORT`      | `8101`                     | Kokoro server listen port                                     |
| `VMUX_KOKORO_VOICE`     | `af_sky`                   | Default Kokoro TTS voice                                      |
| `VMUX_KOKORO_DEVICE`    | `mps` (macOS)              | PyTorch device (mps, cuda, cpu)                               |
| `AUTH_SECRET`           | (auto-generated)           | JWT signing secret (if empty, auth is disabled)               |
| `AUTH_TOKEN_TTL_DAYS`   | `90`                       | How long device authorization tokens last                     |

## Installation

### Prerequisites

- macOS with Homebrew
- Xcode Command Line Tools (`xcode-select --install`)
- Python 3.10+ with `uv` (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
- Node.js 20+ with npm
- LiveKit server (`brew install livekit`)
- cmake (`brew install cmake` — installed automatically by install script if missing)

### Install Script

The install script sets up Whisper (STT) and Kokoro (TTS) under `~/.claude/voice-multiplexer/`:

```bash
# Install with defaults (base model, ~142 MB)
./scripts/install.sh

# Install with a larger, more accurate model (~466 MB)
./scripts/install.sh --whisper-model small

# Force reinstall
./scripts/install.sh --force
```

This compiles whisper.cpp from source with Metal GPU acceleration, sets up a Python venv for Kokoro with PyTorch MPS support, and downloads the required models. Total disk: ~2-3 GB depending on the Whisper model.

### Data Directory

```
~/.claude/voice-multiplexer/
├── whisper/
│   ├── whisper.cpp/              # Compiled binary + source
│   └── models/
│       └── ggml-{model}.bin      # STT model (~142-466 MB)
├── kokoro/
│   └── kokoro-fastapi/           # Python venv + TTS model (~2 GB)
├── logs/
│   ├── start.log                 # Start script output
│   ├── whisper.log               # Whisper server logs
│   └── kokoro.log                # Kokoro server logs
├── devices.json                  # Authorized devices (created on first pairing)
└── voice-multiplexer.env         # Service config (ports, model, device, auth secret)
```

Logs are rotated at 5 MB (one `.old` backup kept per log file).

### Uninstall

```bash
# Remove everything
./scripts/uninstall.sh

# Keep downloaded models (faster reinstall)
./scripts/uninstall.sh --keep-models
```

## Getting Started

### Loading the Plugin

**From a marketplace** (recommended):

```
/plugin install <marketplace-name>/voice-multiplexer
```

**From a local directory** (development):

```bash
alias claude='command claude --plugin-dir /path/to/claude-voice-multiplexer'
```

This gives every Claude session access to the MCP tools and the `/voice-multiplexer:standby` skill. On first use, the standby skill will automatically run the install script if services haven't been set up yet.

### Running the Services

```bash
# Start (production: serves built web app from web/dist)
./scripts/start.sh

# Start (development: also starts Vite dev server with HMR)
./scripts/start.sh --dev

# Check status of all services
./scripts/status.sh

# Stop all services
./scripts/stop.sh
```

The start script will:

1. Check for an existing running instance (prevents duplicates)
2. Load configuration from `~/.claude/voice-multiplexer/voice-multiplexer.env`
3. Rotate service logs exceeding 5 MB
4. Start Whisper STT server on `:8100` (if not already running)
5. Start Kokoro TTS server on `:8101` (if not already running)
6. Start LiveKit server on `:7880` (if not already running)
7. Start the relay server on `:3100`
8. Optionally start the Vite dev server on `:5173`
9. Write a PID file (`.vmux.pid`) for the stop script

All child processes are cleaned up when the start script exits (Ctrl+C or `./scripts/stop.sh`).

### Building the Web App

```bash
cd web
npm install
npm run build   # Production build → dist/ (served by relay server)
```

### Using Voice Mode

1. Start the relay server: `./scripts/start.sh`
2. In any Claude Code session, invoke: `/voice-multiplexer:standby`
3. Open `http://localhost:3100` (or `:5173` in dev mode) on your phone
4. Tap a session to connect, enable mic, and start talking

### Remote Access (Tunnels)

To access the voice multiplexer from outside your local network, expose the relay server via a tunnel. Any tunnel provider works — ngrok, Cloudflare Tunnel, Tailscale Funnel, etc.

**Example with ngrok:**

```bash
ngrok http 3100
```

This gives you a public URL (e.g. `https://abc123.ngrok-free.app`) that you can open on any device.

**How it works:**

LiveKit WebSocket and HTTP traffic is proxied through the relay server at `/livekit/*`, so only one port needs to be tunneled. The token endpoint automatically detects the requesting host and returns the correct URL (e.g. `wss://abc123.ngrok-free.app/livekit`).

**Security notes:**

- **Authentication is required.** When exposed via tunnel, the JWT-based device authentication protects all endpoints. Only devices paired with a valid code can access sessions or audio.
- **Pairing codes can only be generated from localhost.** The `/api/auth/session-code` endpoint rejects requests from non-loopback addresses, so an attacker with the tunnel URL cannot generate their own pairing codes.
- **Pairing attempts are rate-limited.** The `/api/auth/pair` endpoint allows 5 attempts per 60-second window per IP, preventing brute-force attacks on 6-digit codes.
- **Generate codes before tunneling**, or use an already-paired device to generate codes for new devices via the Settings panel.
- **LiveKit traffic** is proxied through the relay server and travels over the tunnel's encrypted connection.

## Project Structure

```
claude-voice-multiplexer/
├── .claude-plugin/
│   └── plugin.json                      # Plugin manifest
├── .mcp.json                            # Bundled MCP server definition
├── README.md                            # This file
├── skills/
│   ├── standby/SKILL.md                 # Standby skill (auto-installs and starts services)
│   ├── start-services/SKILL.md          # Start all services
│   ├── stop-services/SKILL.md           # Stop all services
│   ├── service-status/SKILL.md          # Check service status
│   └── auth-code/SKILL.md              # Generate device pairing code
├── mcp-server/
│   ├── server.py                        # FastMCP server with relay tools
│   └── requirements.txt
├── relay-server/
│   ├── server.py                        # Main server (FastAPI + WebSocket hub)
│   ├── livekit_agent.py                 # LiveKit agent (VAD, audio I/O, status)
│   ├── audio.py                         # Whisper/Kokoro HTTP clients
│   ├── registry.py                      # Session registry with heartbeat timeout
│   ├── auth.py                          # Device authentication (JWT, pairing codes)
│   ├── config.py                        # Configuration (env vars + .env)
│   └── requirements.txt
├── web/
│   ├── src/
│   │   ├── App.tsx                      # Root component
│   │   ├── App.module.scss              # Root layout styles
│   │   ├── main.tsx                     # Entry point
│   │   ├── index.scss                   # Global reset, theme tokens (CSS custom properties)
│   │   ├── components/                  # Folder-based component architecture
│   │   │   ├── Header/                  # Header with settings button
│   │   │   ├── ParticleNetwork/         # Background particle animation
│   │   │   ├── SessionList/             # Session drawer + dropdown menus
│   │   │   ├── VoiceControls/           # LiveKit room, mic/speaker/interrupt
│   │   │   ├── VoiceBar/                # Canvas audio visualizer
│   │   │   ├── Transcript/              # Scrolling transcript + activity
│   │   │   ├── StatusBar/               # Connection status indicators
│   │   │   ├── Settings/                # Settings panel + device management
│   │   │   └── PairScreen/             # Device pairing code entry
│   │   └── hooks/
│   │       ├── useRelay.ts              # WebSocket state, persistent sessions
│   │       ├── useLiveKit.ts            # LiveKit token + connection
│   │       ├── useChime.ts              # Audio feedback chimes
│   │       ├── useSettings.ts           # localStorage settings (theme, auto-listen, mute)
│   │       ├── useTheme.ts             # Theme application (system pref + manual override)
│   │       ├── useAuth.ts              # Auth state, device pairing, device management
│   │       └── useTranscriptDB.ts       # IndexedDB persistence
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
└── scripts/
    ├── install.sh                       # Install Whisper + Kokoro to ~/.claude/voice-multiplexer/
    ├── uninstall.sh                     # Remove installed services and data
    ├── start.sh                         # Start all services
    ├── stop.sh                          # Stop all services
    └── status.sh                        # Check service status
```

## Service Management

### Philosophy

This project uses a **process-group model** rather than persistent LaunchAgent plist files. The start script spawns all services as child processes and manages their lifecycle directly:

- `start.sh` starts Whisper, Kokoro, LiveKit, relay server (and optionally Vite dev server) as child processes
- All children are killed when the parent exits (Ctrl+C or SIGTERM)
- Port-based cleanup ensures orphaned processes (e.g. Kokoro subshell) are also killed
- A PID file (`.vmux.pid`) enables the stop script to find and terminate the process group
- Duplicate-instance protection prevents accidentally starting two copies

This gives you explicit control over when services are running, versus plist-based approaches that keep services running permanently in the background.

### Scripts

| Script              | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `scripts/start.sh`  | Start all services. Writes `.vmux.pid`. Blocks until Ctrl+C.       |
| `scripts/stop.sh`   | Stop running services. Finds process via PID file or process name. |
| `scripts/status.sh` | Check status of all services. `--quiet` for exit code only.        |

### Skills

From any Claude Code session with the plugin loaded:

| Skill                               | Description                             |
| ----------------------------------- | --------------------------------------- |
| `/voice-multiplexer:start-services` | Start services (if not already running) |
| `/voice-multiplexer:stop-services`  | Stop all running services               |
| `/voice-multiplexer:service-status` | Check status of all services            |
| `/voice-multiplexer:auth-code`      | Generate a device pairing code          |

The `standby` skill automatically checks if services are installed and running, and starts them if needed before entering standby mode.

### Process Detection

The stop script uses a two-pass strategy to find the running instance:

1. **PID file** (`.vmux.pid`): Fast, reliable when the start script exited cleanly
2. **Process name search**: Falls back to `pgrep -f "claude-voice-multiplexer:start"` if the PID file is stale or missing (e.g., after an unclean shutdown)

