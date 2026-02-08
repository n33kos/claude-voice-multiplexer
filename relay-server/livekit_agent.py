"""LiveKit agent: joins rooms, handles audio I/O, bridges to Claude sessions.

The agent connects to the LiveKit room as a server-side participant. When a
phone client publishes audio, the agent:
1. Receives audio frames via AudioStream
2. Buffers audio and runs VAD to detect end-of-speech
3. Sends buffered audio to Whisper for transcription
4. Forwards transcribed text to the connected Claude session
5. Receives Claude's response text
6. Synthesizes speech with Kokoro
7. Publishes TTS audio back to the room
"""

import asyncio
import io
import struct
import time

import numpy as np
from livekit import api, rtc

import audio as audio_pipeline
from config import (
    LIVEKIT_URL,
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET,
    LIVEKIT_ROOM,
    SAMPLE_RATE,
    VAD_AGGRESSIVENESS,
    SILENCE_THRESHOLD_MS,
    MIN_SPEECH_DURATION_S,
    ECHO_COOLDOWN_S,
    ENERGY_THRESHOLD,
)

AGENT_IDENTITY = "relay-agent"
LIVEKIT_SAMPLE_RATE = 48000  # LiveKit operates at 48kHz
NUM_CHANNELS = 1

# VAD internals (not user-configurable)
VAD_FRAME_MS = 30  # WebRTC VAD frame size (10, 20, or 30ms)
VAD_SAMPLE_RATE = 16000  # WebRTC VAD only supports 8k, 16k, 32k

# Whisper blank audio artifacts to discard
BLANK_PATTERNS = {
    "[BLANK_AUDIO]",
    "[blank_audio]",
    "(blank audio)",
    "",
}


# Max time to stay in "thinking" after TTS before auto-returning to idle.
# The "listening" signal from Claude bypasses this, but this prevents getting
# permanently stuck if Claude is interrupted or slow to call relay_standby.
THINKING_TIMEOUT_S = 15.0

# Error state auto-recovers to idle after this many seconds.
ERROR_RECOVERY_S = 5.0


class RelayAgent:
    """Server-side LiveKit agent that bridges audio to Claude sessions."""

    def __init__(self, registry, broadcast_fn, notify_status_fn=None, notify_transcript_fn=None):
        self.registry = registry
        self.broadcast_fn = broadcast_fn
        self.notify_status_fn = notify_status_fn
        self.notify_transcript_fn = notify_transcript_fn
        self.room: rtc.Room | None = None
        self.audio_source: rtc.AudioSource | None = None
        self._running = False
        self._audio_buffer: list[np.ndarray] = []
        self._vad = None
        self._pending_response: asyncio.Future | None = None
        self._is_speaking = False
        self._waiting_for_response = False
        self._speaking_ended_at: float = 0.0
        self._idle_timer: asyncio.Task | None = None
        self._error_timer: asyncio.Task | None = None
        self._current_activity: str | None = None
        self._pending_listening: str | None = None
        self._current_state: str = "idle"  # track last known state for new client connections
        self._audio_stream_tasks: dict[str, asyncio.Task] = {}  # participant identity → task

    async def start(self):
        """Connect to LiveKit room and begin processing audio."""
        self._running = True

        # Initialize VAD
        try:
            import webrtcvad
            self._vad = webrtcvad.Vad(VAD_AGGRESSIVENESS)
        except ImportError:
            print("[agent] webrtcvad not installed, using energy-based VAD fallback")

        self.room = rtc.Room()

        # Set up event handlers
        self.room.on("track_subscribed")(self._on_track_subscribed)
        self.room.on("participant_connected")(self._on_participant_connected)
        self.room.on("participant_disconnected")(self._on_participant_disconnected)

        # Generate token and connect
        token = (
            api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
            .with_identity(AGENT_IDENTITY)
            .with_name("Voice Relay Agent")
            .with_grants(api.VideoGrants(room_join=True, room=LIVEKIT_ROOM))
            .to_jwt()
        )

        try:
            await self.room.connect(
                LIVEKIT_URL,
                token,
                options=rtc.RoomOptions(auto_subscribe=True),
            )
            print(f"[agent] Connected to LiveKit room '{LIVEKIT_ROOM}'")
        except Exception as e:
            print(f"[agent] Failed to connect to LiveKit: {e}")
            self._running = False
            return

        # Create audio source for publishing TTS
        self.audio_source = rtc.AudioSource(LIVEKIT_SAMPLE_RATE, NUM_CHANNELS)
        track = rtc.LocalAudioTrack.create_audio_track("agent-voice", self.audio_source)
        opts = rtc.TrackPublishOptions()
        opts.source = rtc.TrackSource.SOURCE_MICROPHONE
        await self.room.local_participant.publish_track(track, opts)
        print("[agent] Published audio track")

    async def stop(self):
        """Disconnect from LiveKit room."""
        self._running = False
        if self.room:
            await self.room.disconnect()
            self.room = None
        print("[agent] Disconnected from LiveKit")

    def _on_participant_connected(self, participant: rtc.RemoteParticipant):
        print(f"[agent] Participant connected: {participant.identity}")

    def _on_participant_disconnected(self, participant: rtc.RemoteParticipant):
        print(f"[agent] Participant disconnected: {participant.identity}")
        # Cancel and clean up the audio stream task for this participant
        task = self._audio_stream_tasks.pop(participant.identity, None)
        if task and not task.done():
            task.cancel()

    def _on_track_subscribed(
        self,
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ):
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            identity = participant.identity
            # Cancel any existing audio stream task for this participant
            # to prevent duplicate processing after reconnects
            existing = self._audio_stream_tasks.get(identity)
            if existing and not existing.done():
                print(f"[agent] Cancelling stale audio stream for {identity}")
                existing.cancel()

            print(f"[agent] Subscribed to audio from {identity}")
            audio_stream = rtc.AudioStream(track)
            task = asyncio.ensure_future(self._process_audio_stream(audio_stream, participant))
            self._audio_stream_tasks[identity] = task

    async def _process_audio_stream(
        self,
        stream: rtc.AudioStream,
        participant: rtc.RemoteParticipant,
    ):
        """Process incoming audio frames with VAD and transcription."""
        self._audio_buffer = []
        speech_detected = False
        silence_ms = 0
        speech_start_time = None

        async for event in stream:
            if not self._running:
                break

            # Skip audio while waiting for Claude or TTS is playing
            if self._waiting_for_response or self._is_speaking:
                continue
            if time.time() - self._speaking_ended_at < ECHO_COOLDOWN_S:
                continue

            frame = event.frame
            # Convert AudioFrame to numpy array (16-bit PCM)
            samples = np.frombuffer(frame.data, dtype=np.int16).copy()

            # Resample from LiveKit's 48kHz to our target rate if needed
            if frame.sample_rate != SAMPLE_RATE:
                from scipy import signal as scipy_signal
                samples = scipy_signal.resample(
                    samples,
                    int(len(samples) * SAMPLE_RATE / frame.sample_rate),
                ).astype(np.int16)

            self._audio_buffer.append(samples)

            # Run VAD
            is_speech = self._detect_speech(samples)

            if is_speech:
                if not speech_detected:
                    speech_detected = True
                    speech_start_time = time.time()
                    print(f"[agent] Speech detected from {participant.identity}")
                silence_ms = 0
            elif speech_detected:
                silence_ms += VAD_FRAME_MS
                speech_duration = time.time() - speech_start_time if speech_start_time else 0

                if silence_ms >= SILENCE_THRESHOLD_MS and speech_duration >= MIN_SPEECH_DURATION_S:
                    # End of utterance — transcribe and process
                    print(f"[agent] End of speech ({speech_duration:.1f}s), transcribing...")
                    try:
                        await self._handle_utterance(participant)
                    except Exception as e:
                        print(f"[agent] Error handling utterance: {e}")

                    # Reset for next utterance
                    self._audio_buffer = []
                    speech_detected = False
                    silence_ms = 0
                    speech_start_time = None

    def _detect_speech(self, samples: np.ndarray) -> bool:
        """Detect speech using WebRTC VAD or energy fallback."""
        if self._vad:
            try:
                # Resample to 16kHz for WebRTC VAD
                from scipy import signal as scipy_signal
                vad_samples = scipy_signal.resample(
                    samples,
                    int(len(samples) * VAD_SAMPLE_RATE / SAMPLE_RATE),
                ).astype(np.int16)

                # WebRTC VAD needs exact frame sizes: 10, 20, or 30ms
                frame_samples = int(VAD_SAMPLE_RATE * VAD_FRAME_MS / 1000)
                if len(vad_samples) >= frame_samples:
                    chunk = vad_samples[:frame_samples]
                    return self._vad.is_speech(chunk.tobytes(), VAD_SAMPLE_RATE)
            except Exception:
                pass

        # Energy-based fallback
        energy = np.sqrt(np.mean(samples.astype(np.float64) ** 2))
        return energy > ENERGY_THRESHOLD

    async def _handle_utterance(self, participant: rtc.RemoteParticipant):
        """Transcribe buffered audio and forward to the connected Claude session."""
        if not self._audio_buffer:
            return

        # Concatenate all audio frames
        all_audio = np.concatenate(self._audio_buffer)

        # Convert to WAV bytes for Whisper
        wav_bytes = self._to_wav(all_audio, SAMPLE_RATE)

        # Find session first so we can send status updates
        session = await self._find_session_for_participant(participant)

        # Transcribe
        if session:
            await self._notify_status(session.session_id, "thinking", "Transcribing speech...")
        try:
            text = await audio_pipeline.transcribe(wav_bytes, "wav")
        except Exception as e:
            print(f"[agent] Whisper STT error: {e}")
            if session:
                await self._notify_status(session.session_id, "error", "Speech-to-text failed. Is Whisper running?")
                self._schedule_error_recovery(session.session_id)
            return
        if not text:
            print("[agent] Transcription empty, skipping")
            if session:
                await self._notify_status(session.session_id, "idle")
            return

        # Filter out Whisper noise artifacts
        stripped = text.strip()
        if stripped in BLANK_PATTERNS or len(stripped) < 2:
            print(f"[agent] Filtered noise transcription: {stripped!r}")
            if session:
                await self._notify_status(session.session_id, "idle")
            return

        print(f"[agent] Transcribed: {text}")

        if not session:
            print("[agent] No Claude session connected for this participant")
            return

        # Send user transcript to web client
        if self.notify_transcript_fn:
            try:
                await self.notify_transcript_fn(session.session_id, "user", text)
            except Exception:
                pass

        # Forward transcription to Claude session
        if session.ws:
            import json
            try:
                await session.ws.send_text(json.dumps({
                    "type": "voice_message",
                    "text": text,
                    "caller": participant.identity,
                    "timestamp": time.time(),
                }))
                print(f"[agent] Forwarded to session '{session.name}'")
                # Disable input until Claude responds and TTS finishes
                self._waiting_for_response = True
                await self._notify_status(session.session_id, "thinking", "Waiting for Claude...")
            except Exception as e:
                print(f"[agent] Session '{session.name}' WebSocket disconnected, removing: {e}")
                await self.registry.unregister(session.session_id)

    async def handle_claude_response(self, session_id: str, text: str):
        """Called when a Claude session sends a text response. Synthesize and play."""
        print(f"[agent] Synthesizing response: {text[:50]}...")

        # Cancel any pending idle timer — another response came in
        if self._idle_timer and not self._idle_timer.done():
            self._idle_timer.cancel()
            self._idle_timer = None

        self._is_speaking = True
        await self._notify_status(session_id, "speaking")
        try:
            # Request PCM format from Kokoro for direct LiveKit publishing
            try:
                audio_bytes = await audio_pipeline.synthesize_pcm(text)
            except Exception as e:
                print(f"[agent] Kokoro TTS error: {e}")
                await self._notify_status(session_id, "error", "Text-to-speech failed. Is Kokoro running?")
                self._schedule_error_recovery(session_id)
                return
            if not audio_bytes:
                print("[agent] TTS synthesis returned empty")
                await self._notify_status(session_id, "error", "Text-to-speech returned no audio.")
                self._schedule_error_recovery(session_id)
                return

            # Publish PCM audio to LiveKit room
            await self._publish_audio(audio_bytes)
        finally:
            self._is_speaking = False
            self._speaking_ended_at = time.time()
            self._audio_buffer = []

            # If Claude already called relay_standby while we were speaking,
            # transition directly to idle instead of thinking.
            if self._pending_listening:
                sid = self._pending_listening
                self._pending_listening = None
                self._waiting_for_response = False
                self._current_activity = None
                await self._notify_status(sid, "idle")
            else:
                # Stay in thinking state — mic stays disabled. Start a fallback
                # timer that auto-transitions to idle if Claude doesn't call
                # relay_standby (send "listening") within the timeout.
                await self._notify_status(session_id, "thinking", "Waiting for Claude...")
                self._idle_timer = asyncio.create_task(
                    self._deferred_idle(session_id)
                )

    async def _deferred_idle(self, session_id: str):
        """Fallback: transition to idle after timeout if no listening signal."""
        try:
            await asyncio.sleep(THINKING_TIMEOUT_S)
            print(f"[agent] Thinking timeout — auto-transitioning to idle")
            self._waiting_for_response = False
            self._current_activity = None
            await self._notify_status(session_id, "idle")
        except asyncio.CancelledError:
            pass

    async def handle_claude_listening(self, session_id: str):
        """Called when Claude enters relay_standby again — ready for next voice input."""
        # Cancel the fallback timer — Claude signaled it's ready
        if self._idle_timer and not self._idle_timer.done():
            self._idle_timer.cancel()
            self._idle_timer = None

        # If still speaking (TTS playing), defer transition until speaking ends.
        # The handle_claude_response finally block will see _pending_listening
        # and transition to idle after TTS finishes.
        if self._is_speaking:
            self._pending_listening = session_id
            return

        self._waiting_for_response = False
        self._current_activity = None
        await self._notify_status(session_id, "idle")

    async def handle_status_update(self, session_id: str, activity: str):
        """Called when Claude sends a status_update with current activity."""
        self._current_activity = activity
        await self._notify_status(session_id, "thinking", activity=activity)

    async def _publish_audio(self, pcm_bytes: bytes):
        """Publish PCM audio bytes to the LiveKit room and wait for playback."""
        if not self.audio_source:
            return

        # PCM is 16-bit mono at SAMPLE_RATE, needs resampling to 48kHz for LiveKit
        samples = np.frombuffer(pcm_bytes, dtype=np.int16)

        if SAMPLE_RATE != LIVEKIT_SAMPLE_RATE:
            from scipy import signal as scipy_signal
            samples = scipy_signal.resample(
                samples,
                int(len(samples) * LIVEKIT_SAMPLE_RATE / SAMPLE_RATE),
            ).astype(np.int16)

        # Calculate playback duration so we can wait for remaining playback
        playback_duration = len(samples) / LIVEKIT_SAMPLE_RATE
        publish_start = time.time()

        # Publish in 10ms chunks (480 samples at 48kHz)
        chunk_size = LIVEKIT_SAMPLE_RATE // 100  # 10ms
        for i in range(0, len(samples), chunk_size):
            chunk = samples[i:i + chunk_size]
            if len(chunk) < chunk_size:
                # Pad last chunk with silence
                chunk = np.pad(chunk, (0, chunk_size - len(chunk)))

            frame = rtc.AudioFrame.create(LIVEKIT_SAMPLE_RATE, NUM_CHANNELS, chunk_size)
            audio_data = np.frombuffer(frame.data, dtype=np.int16)
            np.copyto(audio_data, chunk)
            await self.audio_source.capture_frame(frame)

        # Wait for remaining playback time. capture_frame may pace at
        # real-time, so subtract elapsed publish time from total duration.
        elapsed = time.time() - publish_start
        remaining = playback_duration - elapsed + 0.5  # +0.5s for network jitter
        if remaining > 0:
            await asyncio.sleep(remaining)

    async def _notify_status(self, session_id: str, state: str, activity: str | None = None):
        """Notify connected client of agent status change."""
        self._current_state = state
        self._current_activity = activity
        if self.notify_status_fn:
            try:
                await self.notify_status_fn(session_id, state, activity)
            except Exception:
                pass

    def get_current_status(self) -> dict:
        """Return the current agent status for new client connections."""
        return {"state": self._current_state, "activity": self._current_activity}

    async def _notify_system_message(self, session_id: str, text: str):
        """Send a system-level transcript message to the connected web client."""
        if self.notify_transcript_fn:
            try:
                await self.notify_transcript_fn(session_id, "system", text)
            except Exception:
                pass

    def _schedule_error_recovery(self, session_id: str):
        """Schedule auto-recovery from error state to idle."""
        if self._error_timer and not self._error_timer.done():
            self._error_timer.cancel()
        self._error_timer = asyncio.create_task(self._recover_from_error(session_id))

    async def _recover_from_error(self, session_id: str):
        """Auto-recover from error state after a delay."""
        try:
            await asyncio.sleep(ERROR_RECOVERY_S)
            print("[agent] Error recovery — transitioning to idle")
            self._waiting_for_response = False
            self._current_activity = None
            await self._notify_status(session_id, "idle")
        except asyncio.CancelledError:
            pass

    async def _find_session_for_participant(self, participant: rtc.RemoteParticipant):
        """Find the Claude session connected to this participant."""
        # For now, find the first session with a connected client
        # In the future, map participant identity → client_id → session
        sessions = await self.registry.list_sessions()
        for s in sessions:
            if s.get("connected_client"):
                return await self.registry.get(s["session_id"])
        # Fallback: return first available session
        for s in sessions:
            return await self.registry.get(s["session_id"])
        return None

    @staticmethod
    def _to_wav(samples: np.ndarray, sample_rate: int) -> bytes:
        """Convert numpy int16 samples to WAV bytes."""
        buf = io.BytesIO()
        num_samples = len(samples)
        data_size = num_samples * 2  # 16-bit = 2 bytes per sample

        # WAV header
        buf.write(b"RIFF")
        buf.write(struct.pack("<I", 36 + data_size))
        buf.write(b"WAVE")
        buf.write(b"fmt ")
        buf.write(struct.pack("<I", 16))  # chunk size
        buf.write(struct.pack("<H", 1))  # PCM format
        buf.write(struct.pack("<H", 1))  # mono
        buf.write(struct.pack("<I", sample_rate))
        buf.write(struct.pack("<I", sample_rate * 2))  # byte rate
        buf.write(struct.pack("<H", 2))  # block align
        buf.write(struct.pack("<H", 16))  # bits per sample
        buf.write(b"data")
        buf.write(struct.pack("<I", data_size))
        buf.write(samples.tobytes())

        return buf.getvalue()
