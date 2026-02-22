# Claude Voice Multiplexer

A Claude Code MCP plugin and relay server for remote voice interaction with multiple Claude Code sessions. Talk to your running Claude sessions from anywhere — switch between them, see their output, and control them by voice from your phone or any browser.

**v2.0**: Powered by `vmuxd`, a persistent daemon that manages all services and spawns Claude sessions on demand from the web app.

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
│  - New session spawn │          │  ├── Session registry                    │
│  - Session controls  │          │  └── LiveKit token server                │
│  - Text transcript   │          │                                          │
│  - Agent status      │          │  vmuxd daemon (launchd)                  │
│                      │          │  ├── Service manager                     │
└──────────────────────┘          │  │   ├── vmux-whisper   (auto-restart)   │
                                  │  │   ├── vmux-kokoro    (auto-restart)   │
                                  │  │   ├── vmux-livekit   (auto-restart)   │
                                  │  │   └── vmux-relay     (auto-restart)   │
                                  │  ├── Session manager                     │
                                  │  │   ├── vmux-session-<name> (tmux)      │
                                  │  │   └── ...                             │
                                  │  └── Unix socket IPC (/tmp/vmuxd.sock)   │
                                  └──────────────────────────────────────────┘

For remote access: expose relay server via tunnel (Cloudflare/ngrok/Tailscale)
```

## How It Works

### The Daemon (`vmuxd`)

`vmuxd` is a persistent macOS launchd agent that owns the entire lifecycle of all services:

- **Service manager**: Starts Whisper, Kokoro, LiveKit, and relay server. Monitors each with health checks and auto-restarts on crash with exponential backoff.
- **Session manager**: Spawns Claude Code sessions inside named tmux windows. Each session runs `claude --dangerously-skip-permissions '/voice-multiplexer:standby'` and immediately registers with the relay server.
- **Unix socket IPC**: Exposes `/tmp/vmuxd.sock` (mode 0600) for the `vmux` CLI and the relay server to send commands.
- **Auto-update**: Polls the plugin cache every 60 seconds. If a newer version is found, copies daemon files and restarts via launchd.

### Session Registration (MCP Plugin)

Each Claude Code session has the MCP plugin installed. When the user invokes the standby skill (or the daemon spawns one), the plugin:

1. Connects to the relay server via WebSocket and registers (session name, working directory, metadata)
2. Sends periodic heartbeats to maintain presence in the session registry
3. Listens for incoming voice messages (transcribed text from the relay)
4. When a voice message arrives: delivers the text to Claude, Claude processes it, and sends the conversational response back to the relay
5. The relay synthesizes the response with Kokoro and streams audio back to the client

### Session Spawning Flow

```
Web app "New Session" → POST /api/sessions/spawn {"cwd": "/path/to/project"}
  → relay server → vmux IPC (Unix socket)
    → vmuxd session manager
      → tmux new-session -s "vmux-project-a3f2" -c /path/to/project
        → send-keys: claude --dangerously-skip-permissions '/voice-multiplexer:standby'
          → poll relay /api/sessions until session appears (up to 60s)
            → session visible in web UI → auto-connect
```

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

The agent tracks its state as a structured status object:

```
{state: "thinking", activity: "Transcribing speech..."}
{state: "speaking", activity: null}
{state: "idle", activity: null}
{state: "error", activity: "Speech-to-text failed. Is Whisper running?"}
```

### Session Health

The daemon monitors spawned sessions every 30 seconds:

| Status     | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| `standby`  | Claude is in standby mode, ready for voice input                 |
| `active`   | Claude is processing a request                                   |
| `zombie`   | tmux session alive but relay heartbeat stale >90s                |
| `dead`     | tmux session has exited                                          |

Kill and restart buttons are always visible per session regardless of health state.

## Components

### 1. `vmuxd` Daemon (`daemon/`)

| File                    | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `vmuxd.py`              | Main daemon process (asyncio, launchd entry point)       |
| `service_manager.py`    | Infrastructure service lifecycle + auto-restart          |
| `session_manager.py`    | tmux session spawning, tracking, health monitoring       |
| `ipc_server.py`         | Unix socket IPC server (newline-delimited JSON)          |
| `vmux`                  | CLI wrapper — sends commands to daemon via socket        |
| `VERSION`               | Installed version (used for auto-update comparisons)     |

### 2. `vmux` CLI

```bash
vmux status                     # show daemon + service + session status
vmux spawn /path/to/project     # spawn new Claude session
vmux kill <session-id>          # kill a session
vmux attach <session-id>        # attach to tmux terminal (for debugging)
vmux sessions                   # list active sessions
vmux restart <session-id>       # kill + respawn a session
vmux restart kokoro             # restart an infrastructure service
vmux interrupt <session-id>     # send Ctrl-C to a session
vmux hard-interrupt <session-id># Ctrl-C + MCP reconnect + re-enter standby
vmux auth-code                  # generate a one-time pairing code
vmux update-if-newer            # apply update from plugin cache
vmux shutdown                   # stop daemon and all services
```

### 3. MCP Tools (`relay-server/mcp_tools.py`)

FastMCP tools embedded in the relay server and served over SSE at `/mcp/sse`.

| Tool                 | Description                                                                     |
| -------------------- | ------------------------------------------------------------------------------- |
| `relay_standby`      | Register and enter standby mode. Blocks until a voice message arrives.          |
| `relay_respond`      | Send Claude's response text back to the relay for TTS synthesis.                |
| `relay_activity`     | Update the web client with Claude's current activity.                           |
| `relay_disconnect`   | Unregister from the relay and exit standby mode.                                |
| `relay_status`       | Show current relay connection status.                                           |
| `relay_notify`       | Wake parent session with a notification (for background agents).                |
| `relay_code_block`   | Push a code snippet or diff to the transcript.                                  |
| `relay_file`         | Relay a file directly to the web app (no token cost).                           |
| `relay_image`        | Relay an image directly to the web app.                                         |
| `generate_auth_code` | Generate a 6-digit pairing code for authorizing a new device.                  |

### 4. Relay Server (`relay-server/`)

A Python server (FastAPI + Uvicorn) that bridges the web client, Claude sessions, and local AI services.

**New endpoints (v2.0):**

| Endpoint                              | Type | Description                                         |
| ------------------------------------- | ---- | --------------------------------------------------- |
| `POST /api/sessions/spawn`            | HTTP | Spawn a Claude session via daemon (auth required)   |
| `DELETE /api/sessions/<id>`           | HTTP | Kill a session via daemon (auth required)           |
| `POST /api/sessions/<id>/interrupt`   | HTTP | Hard interrupt via daemon (auth required)           |
| `POST /api/sessions/<id>/restart`     | HTTP | Kill + respawn via daemon (auth required)           |

**All existing endpoints from v1 are preserved.** See the WebSocket protocol documentation in the code.

### 5. React Web App (`web/`)

**New in v2.0:**
- **"+" button** in the session list header — opens a dialog to spawn a new Claude session by directory
- **Health badges** on session cards — amber "zombie", red "dead"
- **Kill / Restart / Hard Interrupt** menu items in the session context menu (for daemon-managed sessions)
- **Authorization: Bearer header** — auth tokens are stored in localStorage and sent as `Authorization: Bearer <jwt>` on all REST requests (previously HTTP-only cookie only)

### 6. Skills (`skills/`)

| Skill            | Description                                                           |
| ---------------- | --------------------------------------------------------------------- |
| `standby`        | Enter standby mode (checks relay is up, no auto-start needed)         |
| `start-services` | Start the daemon via launchctl if not running                         |
| `stop-services`  | Stop all services via `vmux shutdown`                                 |
| `service-status` | Check status via `vmux status`                                        |
| `auth-code`      | Generate a device pairing code via `vmux auth-code`                   |

### 7. Infrastructure

Services are started and supervised by `vmuxd`:

| Service             | Port    | Description                                                  |
| ------------------- | ------- | ------------------------------------------------------------ |
| **Whisper server**  | `:8100` | Local STT (whisper.cpp, compiled from source with Metal GPU) |
| **Kokoro server**   | `:8101` | Local TTS (kokoro-fastapi, PyTorch with MPS acceleration)    |
| **LiveKit server**  | `:7880` | WebRTC media server for audio transport                      |
| **Relay server**    | `:3100` | The core hub (FastAPI + WebSocket)                           |
| **MCP tools**       | `/mcp`  | Embedded in relay server, served over SSE at `/mcp/sse`      |

## Configuration

All settings are configured via `~/.claude/voice-multiplexer/voice-multiplexer.env`, generated by the install script.

**Key settings:**

| Variable                | Default               | Description                                                   |
| ----------------------- | --------------------- | ------------------------------------------------------------- |
| `RELAY_HOST`            | `0.0.0.0`             | Relay server bind address                                     |
| `RELAY_PORT`            | `3100`                | Relay server port                                             |
| `WHISPER_URL`           | `http://127.0.0.1:8100/v1` | Whisper STT endpoint                                   |
| `KOKORO_URL`            | `http://127.0.0.1:8101/v1` | Kokoro TTS endpoint                                    |
| `KOKORO_VOICE`          | `af_heart`            | TTS voice                                                     |
| `LIVEKIT_URL`           | `ws://localhost:7880` | LiveKit server URL                                            |
| `LIVEKIT_API_KEY`       |                       | LiveKit API key                                               |
| `LIVEKIT_API_SECRET`    |                       | LiveKit API secret                                            |
| `SESSION_TIMEOUT`       | `600`                 | Session heartbeat timeout (seconds)                           |
| `AUTH_SECRET`           | (auto-generated)      | JWT signing secret                                            |
| `AUTH_TOKEN_TTL_DAYS`   | `90`                  | How long device authorization tokens last                     |
| `VMUX_DAEMON_SECRET`    | (auto-generated)      | Internal secret for daemon→relay communication                |

## Installation

### Prerequisites

- macOS with Homebrew
- Xcode Command Line Tools (`xcode-select --install`)
- Python 3.10+ with `uv` (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
- Node.js 20+ with npm

### Install Script

```bash
# Install with defaults (base Whisper model, ~142 MB)
./scripts/install.sh

# Install with a larger, more accurate Whisper model
./scripts/install.sh --whisper-model small

# Force reinstall
./scripts/install.sh --force
```

This:
1. Installs prerequisites (cmake, livekit, tmux via Homebrew if missing)
2. Compiles whisper.cpp from source with Metal GPU acceleration
3. Sets up Kokoro TTS with PyTorch MPS support
4. Builds the web app
5. Copies daemon files to `~/.claude/voice-multiplexer/daemon/`
6. Installs `vmux` CLI to `~/.local/bin/vmux`
7. Writes and loads the launchd plist (`com.vmux.daemon`)
8. Prints a one-time pairing code for immediate first-time setup

### Data Directory

```
~/.claude/voice-multiplexer/
├── daemon/
│   ├── vmuxd.py              # Installed daemon (updated by auto-update)
│   ├── service_manager.py
│   ├── session_manager.py
│   ├── ipc_server.py
│   ├── vmux                  # CLI wrapper
│   └── VERSION               # Installed version
├── whisper/
│   ├── whisper.cpp/          # Compiled binary + source
│   └── models/
│       └── ggml-{model}.bin
├── kokoro/
│   └── kokoro-fastapi/       # Python venv + TTS model
├── logs/
│   ├── daemon.log            # vmuxd daemon logs
│   ├── daemon-error.log      # vmuxd stderr
│   ├── whisper.log
│   └── kokoro.log
├── daemon.secret             # Internal daemon↔relay shared secret (0600)
├── daemon.state              # Live PID/session state (updated every 10s)
├── devices.json              # Authorized devices
└── voice-multiplexer.env     # Service config
```

### Launchd Integration

The daemon runs as a macOS launchd agent:

- **Plist**: `~/Library/LaunchAgents/com.vmux.daemon.plist`
- **Auto-start**: starts at login (`RunAtLoad: true`)
- **Auto-restart**: launchd restarts if it crashes (`KeepAlive: true`)
- **Throttle**: 10-second minimum between restarts

```bash
# Control daemon lifecycle
launchctl start com.vmux.daemon   # start now
launchctl stop com.vmux.daemon    # stop (launchd restarts automatically)
launchctl unload ~/Library/LaunchAgents/com.vmux.daemon.plist  # disable auto-start
launchctl load   ~/Library/LaunchAgents/com.vmux.daemon.plist  # re-enable auto-start
```

### Uninstall

```bash
# Remove everything
./scripts/uninstall.sh

# Keep downloaded models (faster reinstall)
./scripts/uninstall.sh --keep-models
```

Before uninstalling, stop the daemon:
```bash
launchctl unload ~/Library/LaunchAgents/com.vmux.daemon.plist
```

## Getting Started

### Loading the Plugin

**From the n33kos marketplace:**
```
/plugin install n33kos/voice-multiplexer
```

**From a local directory (development):**
```bash
alias claude='command claude --plugin-dir /path/to/claude-voice-multiplexer'
```

### First-Time Setup

```bash
./scripts/install.sh
```

The install script sets everything up, starts the daemon, and prints a one-time pairing code. Open `http://localhost:3100` and enter the code to authorize your device. That's it.

### Day-to-Day Usage

The daemon runs automatically in the background after `install.sh`. You don't need to start or stop services manually.

**To enter voice standby in any Claude session:**
```
/voice-multiplexer:standby
```

**To spawn a new Claude session from the web app:**
1. Open `http://localhost:3100`
2. Tap the `+` button in the session list
3. Enter a working directory path
4. The session spawns and connects automatically

**To attach to a session's terminal (for debugging):**
```bash
vmux sessions              # list active sessions
vmux attach <session-id>   # open tmux terminal
```

### Remote Access (Tunnels)

To access the voice multiplexer from outside your local network:

```bash
ngrok http 3100
```

LiveKit traffic is proxied through the relay server at `/livekit/*`, so only one port needs to be tunneled. The token endpoint automatically returns the correct WebSocket URL based on the requesting host.

**Security:**
- JWT device auth protects all endpoints
- Pairing codes can only be generated from localhost or via `vmux auth-code`
- Pairing attempts are rate-limited (5/60s per IP)
- Daemon↔relay channel uses a separate shared secret (`X-Daemon-Secret`)

## Daemon Architecture Details

### IPC Protocol

The Unix socket at `/tmp/vmuxd.sock` (mode 0600) accepts newline-delimited JSON:

```json
{"cmd": "spawn", "cwd": "/path/to/project"}
→ {"ok": true, "session_id": "abc123", "tmux_session": "vmux-project-a3f2", "daemon_id": "d4f1a2b3"}

{"cmd": "kill", "session_id": "abc123"}
→ {"ok": true}

{"cmd": "restart-session", "session_id": "abc123"}
→ {"ok": true, "session_id": "def456", "tmux_session": "vmux-project-e5c7"}

{"cmd": "hard-interrupt", "session_id": "abc123"}
→ {"ok": true}

{"cmd": "restart", "service": "kokoro"}
→ {"ok": true}

{"cmd": "status"}
→ {"ok": true, "daemon_pid": 1234, "services": {...}, "sessions": [...]}

{"cmd": "shutdown"}
→ {"ok": true}
```

### Service Restart Policy

Each service restarts on failure with exponential backoff:
- Attempt 1: 2s delay
- Attempt 2: 4s delay
- Attempt 3: 8s delay
- ...
- Max delay: 60s
- Max attempts: 5 (then gives up — log shows "max restarts reached")

### Relay Restart Recovery

When the relay server restarts (crash or auto-update), existing standby sessions need to reconnect their MCP transport. The daemon detects this by polling `/api/sessions` — sessions that were in standby but no longer appear trigger the hard-interrupt flow:

1. Send Ctrl-C to the tmux pane
2. Wait 1s, run `/mcp reconnect plugin:voice-multiplexer:voice-multiplexer`
3. Wait 2s, run `/voice-multiplexer:standby`

Sessions doing active work show a "relay restarted" warning in the web app.

### Auto-Update Flow

Every 60 seconds, the daemon checks the plugin cache:
```
~/.claude/plugins/cache/n33kos/voice-multiplexer/<version>/plugin.json
```

If `version > installed VERSION`:
1. Copies `daemon/` from cache to `~/.claude/voice-multiplexer/daemon/`
2. Writes new version to `VERSION`
3. Sets shutdown event → launchd restarts via KeepAlive

## Project Structure

```
claude-voice-multiplexer/
├── .claude-plugin/
│   └── plugin.json                      # Plugin manifest (v2.0.0)
├── .mcp.json                            # Bundled MCP server definition
├── README.md
├── daemon/
│   ├── vmuxd.py                         # Main daemon process
│   ├── service_manager.py               # Service lifecycle + auto-restart
│   ├── session_manager.py               # tmux session spawning + tracking
│   ├── ipc_server.py                    # Unix socket IPC server
│   ├── vmux                             # CLI wrapper (Python, executable)
│   └── VERSION                          # Installed daemon version
├── skills/
│   ├── standby/SKILL.md
│   ├── start-services/SKILL.md
│   ├── stop-services/SKILL.md
│   ├── service-status/SKILL.md
│   └── auth-code/SKILL.md
├── relay-server/
│   ├── server.py                        # FastAPI server + session control endpoints
│   ├── mcp_tools.py                     # FastMCP tools over SSE
│   ├── livekit_agent.py                 # LiveKit agent (VAD, STT, TTS)
│   ├── audio.py                         # Whisper/Kokoro clients
│   ├── registry.py                      # Session registry
│   ├── auth.py                          # JWT auth + device management
│   ├── config.py                        # Configuration (env vars)
│   └── requirements.txt
├── web/
│   └── src/
│       ├── hooks/
│       │   ├── useRelay.ts              # WebSocket + session control
│       │   ├── useAuth.ts               # Auth with Bearer header
│       │   └── ...
│       └── components/
│           ├── SessionList/             # Session drawer + New Session button
│           └── ...
└── scripts/
    ├── install.sh                       # Full install + daemon setup + launchd
    ├── start.sh                         # Compatibility wrapper (delegates to vmux)
    ├── stop.sh                          # Compatibility wrapper (delegates to vmux)
    ├── status.sh                        # Compatibility wrapper (delegates to vmux)
    └── uninstall.sh
```

## Migration from v1

If you're upgrading from v1.x:

1. Update the plugin in Claude Code
2. The daemon's 60-second polling detects the new version in the plugin cache and self-updates automatically
3. After the daemon restarts, services will be managed by launchd — no need for manual `start.sh`

Existing start.sh / stop.sh calls still work (they delegate to `vmux` or fall back to legacy mode).
