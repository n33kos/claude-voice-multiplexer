# Plan: Remove Standby Mode — Direct Tmux Injection + Stop Hook TTS

**Status:** DRAFT — prototype only, do not commit/push until fully validated.
**Version target:** 3.7.0 (breaking change for MCP plugin consumers).

---

## 1. Motivation

Today the voice loop is **blocking by design**: Claude's MCP plugin calls `relay_standby()` which waits on an asyncio.Queue inside the relay. When a transcription arrives, the queue delivers it as the tool return value. Claude processes, calls `relay_respond()`, then loops back into standby.

This model was a product of early MCP constraints — the tool return channel was the only reliable bidirectional path. It has real downsides:

- **No mid-stream interrupts.** You can't interject while Claude is working.
- **Rich CLI features are hidden.** Skills, `/ask`-style prompts, slash menus, permission dialogs are all bypassed or broken by standby.
- **Fragile reconnection.** Every relay/daemon restart requires six baked-in `/mcp reconnect + /voice-multiplexer:standby` send-keys sequences across `hard_interrupt`, `clear_context`, `compact_context`, `change_model`, `reconnect_session`, and the web `interrupt` endpoint.
- **Heartbeat/zombie machinery exists only to keep standby alive.**

The new model treats voice as **typing**: transcriptions go directly into the tmux pane via `send-keys`, and Claude's responses are extracted by a **Stop hook** that reads the transcript JSONL and ships text to Kokoro TTS. Claude never needs to know voice exists.

---

## 2. Target Architecture

```
┌──────────────┐
│  Web App     │  mic capture → LiveKit → relay
└──────┬───────┘
       │
       ▼
┌──────────────────────────┐
│  Relay (LiveKit agent)   │
│   • VAD + Whisper STT    │
│   • Kokoro TTS           │
│   • Cancelable TTS stream│
└──────┬───────────────────┘
       │ transcription via
       │ HTTP → daemon IPC
       ▼
┌──────────────────────────┐
│  Daemon (vmuxd)          │
│   • send_keys text + Enter│
└──────┬───────────────────┘
       │ tmux send-keys
       ▼
┌──────────────────────────┐
│  Claude Code (in tmux)   │
│   • Stop hook fires at   │
│     end of each turn     │
│   • Hook POSTs last       │
│     assistant text to     │
│     relay /tts endpoint   │
└──────┬───────────────────┘
       │ HTTP POST
       ▼
  relay → Kokoro → LiveKit → web → speakers
```

**Defining properties:**

- `relay_standby()` is **removed**. The MCP plugin's standby skill is replaced by a no-op or a minimal "status" skill.
- `relay_respond()` is **retained but optional**. Claude can still call it to emit in-turn interjections. Default flow doesn't need it.
- The primary voice-in mechanism is `tmux send-keys -l <text>` + Enter.
- The primary voice-out mechanism is a **Stop hook** that reads the last assistant message from the transcript JSONL and POSTs it to the relay for TTS.
- TTS is **cancelable by user speech** (VAD-triggered).

---

## 3. Phased Implementation

### Phase 0 — Prototype scaffolding (no user-visible changes)

- Add a new relay endpoint `POST /api/sessions/{session_id}/tts` that accepts `{text, interruptible: true}` and pipes to Kokoro+LiveKit (same path `handle_claude_response` uses today, minus the `relay_respond` wrapper).
- Add a new daemon IPC command `inject-text <session_id> <text>` that calls `send_keys(-l, text)` + `send_keys(Enter)`. Keep the existing `send-keys` command; this is a convenience wrapper.
- Write `scripts/vmux-stop-hook.sh` that reads Stop hook stdin, extracts the last assistant text from `transcript_path`, and POSTs it to `/api/sessions/{session_id}/tts`. Model it on `scripts/vmux-statusline.sh`.
- **No removal yet.** Old standby loop still runs alongside. Good for A/B testing.

### Phase 1 — Stop hook as primary speaker

- Register the stop hook in `~/.claude/settings.json` under `hooks.Stop` (need to confirm exact schema — see Open Questions).
- Add a per-session flag on the relay: `voice_out_mode: "standby" | "hook"`. Default `"standby"` for backwards compat during prototype.
- Web app adds a dev toggle to switch between modes per session.
- Test: switch a session to `"hook"` mode, verify TTS plays on assistant message completion, verify no double-speak when both standby AND hook fire.

### Phase 2 — Tmux send-keys as primary listener

- Modify `livekit_agent.py::forward_transcription_to_session()` to check a per-session `voice_in_mode` flag. When `"send-keys"`, call daemon IPC `inject-text` instead of `voice_queue.put_nowait()`.
- Handle multi-line transcripts: convert `\n` in text to actual Enter presses (or reject/flatten; see Gotcha #3).
- Test: speak a sentence, verify it appears in the Claude prompt and gets submitted.

### Phase 3 — Interruption semantics

- Add a "cancel" signal on the TTS pipeline: `Room._tts_cancel_event: asyncio.Event`. The `_play_tts_response` loop checks the event between PCM chunks and aborts if set.
- LiveKit agent's VAD loop: when user speech is detected WHILE `_is_speaking = True`, set the cancel event.
- Web UI: the current "cancel interrupt" button should change behavior — it now calls `/api/sessions/{id}/cancel-tts` which sets the cancel event on the relay, not `hard_interrupt` on the tmux side.
- Alternative: remove the button entirely; any mic-enable action during TTS implicitly cancels (per Nick's proposal).

### Phase 4 — Retire the standby loop

Once Phases 1-3 are stable across multiple sessions:

- Delete `relay_standby()` MCP tool (or stub it to no-op for backward compat).
- Delete `voice_queue` and its drainage logic in `registry.py`.
- Delete `_heartbeat_loop` and `_session_heartbeats` in `mcp_tools.py`.
- Delete the six sites in `session_manager.py` that send `/voice-multiplexer:standby` at the end of an action. They just do Ctrl-C + `/mcp reconnect` and stop.
- Delete the standby skill file from the plugin source, bump version 3.7.0.
- Update the plugin README with migration notes.

### Phase 5 — UI cleanup

- Remove `AgentState = "idle" | "thinking" | "speaking"` transitions that were keyed off `relay_standby` returning. New states are keyed off TTS playback events and send-keys completion.
- Possibly simplify down to just `"speaking" | "listening"` since "thinking" no longer has a clean boundary.

---

## 4. Blockers & Gotchas

### #1 — Send-keys during modal prompts

**Problem:** If Claude is inside a `/permissions` confirmation, `/model` picker, or a bash tool-result continuation prompt, `send-keys` text goes INTO the modal, not the main prompt.

**Proposals (pick one):**

1. **State-gate send-keys.** Use the statusline hook to write `prompt_state: idle | tool_use | modal` to the per-session JSON file we already maintain. Daemon reads this before injecting; if not `idle`, buffers the text and sends it after transitioning back.
2. **Just send it anyway.** Typing during a modal is what a human would do — the user has enough signal from the terminal view to know when to speak. Keep it dumb and let the user adapt.
3. **Prefix with Escape.** Send an Escape keypress first to dismiss any modal, then type. This is destructive if they were in the middle of a real dialog.

Recommended: start with **option 2** (dumb injection), add option 1 only if it proves annoying in practice.

### #2 — Mic auto-enable after TTS

**Problem:** Today the web client auto-enables the mic when `handle_claude_listening()` fires (i.e., when Claude re-enters standby). Without standby, we need a different "Claude is ready for you" signal.

**Proposal:** The Stop hook writes two things:
- POST to `/api/sessions/{id}/tts` with the text — this plays audio
- POST to `/api/sessions/{id}/turn-complete` — relay broadcasts a WebSocket message to the web client

The web client's mic-enable logic becomes: `enable_mic = tts_finished && turn_complete`. If TTS finishes before `turn-complete`, wait. If `turn-complete` fires before TTS finishes, wait.

### #3 — Multi-line transcriptions

**Problem:** Whisper can return `"Line 1\nLine 2"`. `tmux send-keys -l "$text"` passes newlines as literal characters, which Claude Code's input widget interprets as **submit**, so "Line 1" submits prematurely and "Line 2" becomes the next turn.

**Proposal:** In the daemon's `inject-text` handler, split on newlines and replace internal newlines with **spaces** (or a semicolon). Only the trailing Enter key is sent separately. This loses the multi-sentence structure but keeps the turn atomic. Alternative: use `Shift+Enter` for inline newlines, but Claude Code's input widget varies by version.

Recommended: flatten newlines to spaces. Test if there are edge cases where users dictate "new line" literally (they shouldn't in a voice UX).

### #4 — relay_notify from background agents

**Problem:** Background agents currently call `relay_notify(message)` to wake the parent from standby. Without standby, there's no queue to push to.

**Proposal:** `relay_notify()` stays as a tool but is redefined:
- It POSTs to the new `/api/sessions/{id}/tts` endpoint with the notification text (so the user hears "Agent X finished: ...").
- It also calls `inject-text` with a prefix like `[AGENT NOTIFY] <message>` so the parent session sees it as typed input and can react.

This way the agent's completion message becomes part of the parent's conversation history. The parent's next Stop hook will then TTS the parent's own response, which is natural.

### #5 — Heartbeat/zombie detection

**Problem:** The daemon's zombie detection (session_manager.py:850-864) uses `last_relay_heartbeat` age > 90s to trigger `hard_interrupt`. Heartbeats come from the standby MCP SSE loop.

**Proposal:** Two options:
- **Drop zombie detection.** Tmux sessions don't die silently; if the user restarted the daemon, the next tmux send-keys will just work. The whole reconnection dance was a standby-specific concern.
- **Repurpose heartbeat.** Have the Stop hook also POST a heartbeat every time it fires. This is imprecise (gaps during long tool runs) but enough to detect totally dead sessions.

Recommended: drop it. The three real failure modes are: tmux session missing (already detected by `_tmux_has_session`), daemon dead (detected elsewhere), or relay dead (detected by web client). Standby-specific zombie detection was a workaround for MCP SSE drops that don't apply anymore.

### #6 — TTS cancellation race

**Problem:** User speaks mid-TTS. We cancel the Kokoro stream. But the remaining PCM chunks may already be buffered in LiveKit's audio source and still play for ~200ms.

**Proposal:** Accept this as latency. Kokoro streams chunks ~50ms each; two chunks of overlap is acceptable. If it's actually intrusive, we can fade-out the last published chunk to zero amplitude.

### #7 — The six `/voice-multiplexer:standby` injection sites

Current sites (all in `daemon/session_manager.py`):

| Method | Purpose | Today's last step |
|---|---|---|
| `hard_interrupt` | Break Claude + reconnect MCP | send `/voice-multiplexer:standby` |
| `clear_context` | Ctrl-C + `/clear` + reconnect | send `/voice-multiplexer:standby` |
| `compact_context` | Ctrl-C + `/compact` + reconnect | send `/voice-multiplexer:standby` |
| `change_model` | Ctrl-C + `/model X` + reconnect | send `/voice-multiplexer:standby` |
| `reconnect_session` | `/mcp reconnect` | send `/voice-multiplexer:standby` |
| (web `/interrupt` endpoint) | Calls `hard_interrupt` | (via hard_interrupt) |

**Proposal:** In Phase 4, strip the `/voice-multiplexer:standby` line from all six. After Ctrl-C and slash command, Claude just returns to its prompt. Voice still works because it's now send-keys-based, not standby-based.

Intermediate: during Phase 1-3, keep these intact so we can A/B test. A feature flag `voice_multiplexer.use_standby_skill = bool` in the daemon env controls whether standby is injected.

### #8 — The skill file lives in the marketplace cache

The standby skill currently lives at `~/.claude/plugins/cache/n33kos/voice-multiplexer/<version>/skills/standby/`. When we bump to 3.7.0 and publish, users will auto-update. But their cached 3.6.x skill may still load until they `/mcp reconnect`.

**Proposal:** In 3.7.0, the standby skill file is retained but rewritten to a short skill that:
- Prints a deprecation message
- Does NOT enter a standby loop
- Exits immediately

This way if a user invokes `/voice-multiplexer:standby` out of habit, they get a friendly notice instead of a broken loop.

### #9 — Claude Code Stop hook schema

We don't fully know Claude Code's Stop hook input schema. The statusline hook schema is known (session_id, model, context_window, cost, cwd, transcript_path, version, exceeds_200k_tokens). The Stop hook likely gets similar metadata but may also include the `stop_reason` and possibly the last message content directly.

**Proposal:** Before Phase 1 starts, run a discovery test — register a dummy Stop hook that just `cat > /tmp/stop_hook_input.txt` the stdin. Inspect. Then design the real hook script.

**Action item:** Research Claude Code's Stop hook schema via web search before writing the hook script.

### #10 — TTS for tool-only turns

**Problem:** Not every assistant turn ends with text. Sometimes Claude just calls a tool (e.g., "reading file X") and the turn ends. The Stop hook fires, but the last message has no text content — only tool_use blocks.

**Proposal:** The Stop hook's text extraction returns empty string → no TTS POST → no audio. Simple skip. The user sees the activity in the terminal overlay and on the relay_activity events that we already have.

Alternative: emit a subtle chime instead of TTS for tool-only turns so the user knows Claude is still working.

---

## 5. File-by-File Changes

### Relay server (`relay-server/`)

- **`mcp_tools.py`** — Phase 4: delete `relay_standby` (lines 182-239), delete `_heartbeat_loop` (41-53), delete `_session_heartbeats` dict (70-71). Keep `relay_respond` but simplify (no session keep-alive needed). Redefine `relay_notify` per Gotcha #4.
- **`registry.py`** — Phase 4: delete `voice_queue` field (line 31), delete queue drainage on unregister (97-102) and pruning (149-152). Keep heartbeat-based staleness for UI purposes only.
- **`livekit_agent.py`** — Phase 2: modify `forward_transcription_to_session()` (640-656) to call daemon IPC `inject-text` when `voice_in_mode == "send-keys"`. Phase 3: add `_tts_cancel_event` to `Room`, wire into `_play_tts_response` (680-750). Phase 5: simplify `AgentState` transitions.
- **`server.py`** — Phase 0: add `POST /api/sessions/{id}/tts` and `POST /api/sessions/{id}/turn-complete` endpoints. Phase 3: add `POST /api/sessions/{id}/cancel-tts`. Phase 4: update `/interrupt` endpoint not to rely on standby recovery.

### Daemon (`daemon/`)

- **`session_manager.py`** — Phase 0: add `inject_text(session_id, text)` method wrapping `send_keys(-l, text)` + Enter. Phase 4: remove `/voice-multiplexer:standby` trailing injections in `hard_interrupt` (273-301), `clear_context` (303-354), `compact_context` (356-407), `change_model` (409-465), `reconnect_session` (482-520). Optionally drop zombie detection (850-864).
- **`vmuxd.py`** — Phase 0: add IPC handler for `inject-text` command.

### Scripts (`scripts/`)

- **`vmux-stop-hook.sh`** — NEW. Reads Stop hook stdin, parses `transcript_path` + `session_id`, extracts last assistant message text from JSONL, POSTs to relay.
- **`install.sh`** — Add Stop hook configuration to `~/.claude/settings.json` under `hooks.Stop`.

### Web UI (`web/src/`)

- **`hooks/useRelay.ts`** — Phase 3: listen for `turn-complete` WebSocket messages. Phase 5: simplify `AgentState`.
- **`components/VoiceBar/VoiceBar.tsx`** — Phase 3: update state display. Optionally remove the "cancel interrupt" button (Nick's preference).
- **`components/VoiceControls/VoiceControls.tsx`** — Phase 3: mic-enable now driven by `turn-complete + tts-finished`. Clicking mic while `is_speaking=true` cancels TTS.

### MCP plugin (`.claude-plugin/`, `skills/`)

- **`plugin.json`** — Phase 4: bump to 3.7.0.
- **`skills/standby/SKILL.md`** — Phase 4: rewrite to a short deprecation notice. No longer enters a loop.

### Settings

- **`~/.claude/settings.json`** — Phase 1: register Stop hook. Installer handles this.

---

## 6. Testing Strategy

1. **Local A/B mode (Phase 0-3):** Per-session mode flags let us run old and new loops side by side. Flip one session to new mode, keep another on old, verify both work.
2. **Stop hook dry run:** Dummy hook that just logs input JSON. Verify schema before writing real hook.
3. **Modal stress test:** Trigger `/permissions` prompt, send voice input, observe behavior. Document.
4. **Interrupt stress test:** Start a long TTS response ("explain the codebase"), speak over it, verify cancel works within 500ms.
5. **Background agent notify:** Launch a Tier 3 agent, wait for relay_notify, verify the parent sees the notification as typed input.
6. **Reconnect sequences:** Kill daemon mid-session, restart, verify voice still works without any standby-related recovery.
7. **Multi-line transcript:** Dictate "line one period new line line two", verify single-turn behavior.
8. **Tool-only turn:** Ask Claude to "just run `ls`", verify no spurious TTS for empty text content.

---

## 7. Migration & Rollback

- Phase 0-3 are **non-breaking**. Old standby still works. Users on 3.6.x are unaffected.
- Phase 4-5 is the breaking change. Bump to 3.7.0.
- Rollback path: revert the plugin version. Users re-run `/mcp reconnect` and get 3.6.x behavior back.
- Installer should detect 3.6.x settings.json entries and offer to migrate.

---

## 8. Decisions (resolved 2026-04-23)

1. **Stop hook schema:** Web-research first to accelerate; verify empirically only if research is incomplete.
2. **Multi-line:** Newlines → semicolons (preserves pause cadence). Fall back to spaces only if semicolons cause parsing issues.
3. **Cancel button:** Remove entirely. Mic-click while TTS is playing is the new cancel signal.
4. **Tool-only turns:** Silent. The existing activity status overlay is enough feedback. Revisit only if it feels confusing.
5. **Background agent notifications:** Keep existing behavior (no TTS auto-route). Parent will narrate completion naturally when it processes the notification.
6. **Timeline:** Land Phases 0-3 as one continuous push. Update the live install dir at `~/.claude/voice-multiplexer/` after every change; restart the daemon/relay as needed for a tight feedback loop. No baking period. Phase 4 is gated on Nick's signal after real-world usage.
7. **Standby skill deprecation:** Silent delete. Remove the `/voice-multiplexer:standby` skill entirely in 3.7.0. No external consumers.

---

## 9. Rough Effort Estimate

- **Phase 0 (scaffolding):** 2-3 hours
- **Phase 1 (stop hook + TTS pipeline):** 3-4 hours including dry-run schema discovery
- **Phase 2 (tmux send-keys voice in):** 2 hours
- **Phase 3 (interruption):** 3-4 hours
- **Phase 4 (standby removal):** 2 hours
- **Phase 5 (UI cleanup):** 2-3 hours
- **Testing & polish:** 4-6 hours

Total: ~18-24 hours of focused work. Recommend spreading across 2-3 sessions with testing in between.
