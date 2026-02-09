"""LiveKit agent: manages per-session rooms, handles audio I/O, bridges to Claude sessions.

Each Claude session gets its own LiveKit room. When a session registers, the agent
joins that room. When a phone client connects to a session, the agent in that room:
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
import re
import struct
import time

import numpy as np
from livekit import api, rtc

import audio as audio_pipeline
from config import (
    LIVEKIT_URL,
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET,
    SAMPLE_RATE,
    VAD_AGGRESSIVENESS,
    SILENCE_THRESHOLD_MS,
    MIN_SPEECH_DURATION_S,
    ECHO_COOLDOWN_S,
    ENERGY_THRESHOLD,
    MAX_RECORDING_S,
)

AGENT_IDENTITY_PREFIX = "relay-agent"
LIVEKIT_SAMPLE_RATE = 48000  # LiveKit operates at 48kHz
NUM_CHANNELS = 1

# VAD internals (not user-configurable)
VAD_FRAME_MS = 30  # WebRTC VAD frame size (10, 20, or 30ms)
VAD_SAMPLE_RATE = 16000  # WebRTC VAD only supports 8k, 16k, 32k

# Whisper noise/hallucination filtering.
#
# When Whisper processes silence or ambient noise it frequently hallucinates
# well-known phrases (YouTube outros, subtitle credits, single filler words).
# We maintain two lists: exact-match patterns (compared case-insensitively
# after stripping punctuation) and substring patterns (if the transcript
# *contains* any of these, it's filtered).
#
# Sources:
#   - https://arxiv.org/html/2501.11378v1 (AGH University hallucination study)
#   - https://github.com/openai/whisper/discussions/679
#   - https://github.com/openai/whisper/discussions/928
#   - https://github.com/openai/whisper/discussions/1455
#   - https://github.com/openai/whisper/discussions/1873
#   - https://huggingface.co/datasets/sachaarbonel/whisper-hallucinations

# Transcriptions matching these exactly (case-insensitive, punctuation-stripped)
# are discarded. Covers the top silence hallucinations by frequency.
NOISE_EXACT = {
    # Blank/silence markers
    "[blank_audio]",
    "(blank audio)",
    "[silence]",
    "(silence)",
    "[inaudible]",
    ">>",
    # Top single-word/short hallucinations on silence
    "you",
    "so",
    "the",
    "oh",
    "okay",
    "bye",
    "bye-bye",
    "bye bye",
    "thank you",
    "thank you very much",
    "thanks",
    "i'm sorry",
    "oh my god",
    "hmm",
    "huh",
    "ah",
    "uh",
    "um",
    "mm",
    "yeah",
    # YouTube outro hallucinations
    "thanks for watching",
    "thank you for watching",
    "i'll see you in the next video",
    "i'll see you next time",
    "see you next time",
    "see you in the next one",
    "i'll see you later",
    "thank you bye",
    "the end",
    "we'll be right back",
    "stay tuned",
    # Sound/music markers
    "[music]",
    "(music)",
    "[applause]",
    "(applause)",
    "[laughter]",
    "(laughter)",
    "[typing]",
    "[clapping]",
    "[buzzing]",
    "\u266a",
    "\u266a\u266a",
    "\u266a \u266a \u266a",
    "\u266b",
    # Attribution artifacts
    "satsang with mooji",
    "www.mooji.org",
    "transcript emily beynon",
    "transcription outsourcing llc",
    "transcription outsourcing",
    "transcription by castingwords",
    "copyright wdr",
}

# If the transcript contains any of these substrings (case-insensitive),
# it's filtered. Catches variations in punctuation and phrasing.
NOISE_SUBSTRINGS = [
    "subtitles by",
    "transcribed by",
    "transcription by",
    "translation by",
    "captions by",
    "subtitles made by",
    "amara.org",
    "otter.ai",
    "rev.com",
    "subscribe",
    "thanks for watching",
    "thank you for watching",
    "don't forget to like",
    "please like and subscribe",
    "like and subscribe",
    "for more information, visit",
    "sous-titres",
    "untertitel",
    "sottotitoli",
    "legendas pela comunidade",
]

# Max time to stay in "thinking" after TTS before auto-returning to idle.
THINKING_TIMEOUT_S = 15.0

# Error state auto-recovers to idle after this many seconds.
ERROR_RECOVERY_S = 5.0


class SessionRoom:
    """Per-session LiveKit room with its own audio pipeline and state machine."""

    def __init__(self, session_id: str, room_name: str, registry, notify_status_fn, notify_transcript_fn):
        self.session_id = session_id
        self.room_name = room_name
        self.registry = registry
        self.notify_status_fn = notify_status_fn
        self.notify_transcript_fn = notify_transcript_fn

        self.room: rtc.Room | None = None
        self.audio_source: rtc.AudioSource | None = None
        self._running = False

        # Audio/VAD state
        self._audio_buffer: list[np.ndarray] = []
        self._vad = None
        self._is_speaking = False
        self._waiting_for_response = False
        self._speaking_ended_at: float = 0.0

        # Status state machine
        self._current_state: str = "idle"
        self._current_activity: str | None = None
        self._idle_timer: asyncio.Task | None = None
        self._error_timer: asyncio.Task | None = None
        self._pending_listening: str | None = None

        # Track audio stream tasks per participant
        self._audio_stream_tasks: dict[str, asyncio.Task] = {}

    async def start(self):
        """Connect to this session's LiveKit room."""
        self._running = True

        # Initialize VAD
        try:
            import webrtcvad
            self._vad = webrtcvad.Vad(VAD_AGGRESSIVENESS)
        except ImportError:
            print(f"[room:{self.room_name}] webrtcvad not installed, using energy-based VAD")

        self.room = rtc.Room()

        # Set up event handlers
        self.room.on("track_subscribed")(self._on_track_subscribed)
        self.room.on("participant_connected")(self._on_participant_connected)
        self.room.on("participant_disconnected")(self._on_participant_disconnected)

        # Generate token for this specific room
        identity = f"{AGENT_IDENTITY_PREFIX}-{self.room_name}"
        token = (
            api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
            .with_identity(identity)
            .with_name(f"Agent ({self.room_name})")
            .with_grants(api.VideoGrants(room_join=True, room=self.room_name))
            .to_jwt()
        )

        try:
            await self.room.connect(
                LIVEKIT_URL,
                token,
                options=rtc.RoomOptions(auto_subscribe=True),
            )
            print(f"[room:{self.room_name}] Connected to LiveKit room")
        except Exception as e:
            print(f"[room:{self.room_name}] Failed to connect to LiveKit: {e}")
            self._running = False
            return

        # Create audio source for publishing TTS
        self.audio_source = rtc.AudioSource(LIVEKIT_SAMPLE_RATE, NUM_CHANNELS)
        track = rtc.LocalAudioTrack.create_audio_track("agent-voice", self.audio_source)
        opts = rtc.TrackPublishOptions()
        opts.source = rtc.TrackSource.SOURCE_MICROPHONE
        await self.room.local_participant.publish_track(track, opts)
        print(f"[room:{self.room_name}] Published audio track")

    async def stop(self):
        """Disconnect from LiveKit room and clean up."""
        self._running = False

        # Cancel all audio stream tasks
        for task in self._audio_stream_tasks.values():
            if not task.done():
                task.cancel()
        self._audio_stream_tasks.clear()

        # Cancel timers
        if self._idle_timer and not self._idle_timer.done():
            self._idle_timer.cancel()
        if self._error_timer and not self._error_timer.done():
            self._error_timer.cancel()

        if self.room:
            await self.room.disconnect()
            self.room = None
        print(f"[room:{self.room_name}] Disconnected")

    def _on_participant_connected(self, participant: rtc.RemoteParticipant):
        print(f"[room:{self.room_name}] Participant connected: {participant.identity}")

    def _on_participant_disconnected(self, participant: rtc.RemoteParticipant):
        print(f"[room:{self.room_name}] Participant disconnected: {participant.identity}")
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
            existing = self._audio_stream_tasks.get(identity)
            if existing and not existing.done():
                print(f"[room:{self.room_name}] Cancelling stale audio stream for {identity}")
                existing.cancel()

            print(f"[room:{self.room_name}] Subscribed to audio from {identity}")
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

            if self._waiting_for_response or self._is_speaking:
                continue
            if time.time() - self._speaking_ended_at < ECHO_COOLDOWN_S:
                continue

            frame = event.frame
            samples = np.frombuffer(frame.data, dtype=np.int16).copy()

            if frame.sample_rate != SAMPLE_RATE:
                from scipy import signal as scipy_signal
                samples = scipy_signal.resample(
                    samples,
                    int(len(samples) * SAMPLE_RATE / frame.sample_rate),
                ).astype(np.int16)

            self._audio_buffer.append(samples)

            is_speech = self._detect_speech(samples)

            if is_speech:
                if not speech_detected:
                    speech_detected = True
                    speech_start_time = time.time()
                    print(f"[room:{self.room_name}] Speech detected from {participant.identity}")
                silence_ms = 0
            elif speech_detected:
                silence_ms += VAD_FRAME_MS

            # Check both silence-based end-of-speech and max recording timeout
            if speech_detected and speech_start_time:
                speech_duration = time.time() - speech_start_time
                timed_out = speech_duration >= MAX_RECORDING_S
                silence_ended = silence_ms >= SILENCE_THRESHOLD_MS and speech_duration >= MIN_SPEECH_DURATION_S

                if timed_out or silence_ended:
                    if timed_out:
                        print(f"[room:{self.room_name}] Max recording timeout ({speech_duration:.1f}s), transcribing...")
                    else:
                        print(f"[room:{self.room_name}] End of speech ({speech_duration:.1f}s), transcribing...")
                    try:
                        await self._handle_utterance(participant)
                    except Exception as e:
                        print(f"[room:{self.room_name}] Error handling utterance: {e}")

                    self._audio_buffer = []
                    speech_detected = False
                    silence_ms = 0
                    speech_start_time = None

    def _detect_speech(self, samples: np.ndarray) -> bool:
        """Detect speech using WebRTC VAD or energy fallback."""
        if self._vad:
            try:
                from scipy import signal as scipy_signal
                vad_samples = scipy_signal.resample(
                    samples,
                    int(len(samples) * VAD_SAMPLE_RATE / SAMPLE_RATE),
                ).astype(np.int16)

                frame_samples = int(VAD_SAMPLE_RATE * VAD_FRAME_MS / 1000)
                if len(vad_samples) >= frame_samples:
                    chunk = vad_samples[:frame_samples]
                    return self._vad.is_speech(chunk.tobytes(), VAD_SAMPLE_RATE)
            except Exception:
                pass

        energy = np.sqrt(np.mean(samples.astype(np.float64) ** 2))
        return energy > ENERGY_THRESHOLD

    async def _handle_utterance(self, participant: rtc.RemoteParticipant):
        """Transcribe buffered audio and forward to the connected Claude session."""
        if not self._audio_buffer:
            return

        all_audio = np.concatenate(self._audio_buffer)
        wav_bytes = _to_wav(all_audio, SAMPLE_RATE)

        session = await self.registry.get(self.session_id)

        if session:
            await self._notify_status("thinking", "Transcribing speech...")
        try:
            text = await audio_pipeline.transcribe(wav_bytes, "wav")
        except Exception as e:
            print(f"[room:{self.room_name}] Whisper STT error: {e}")
            if session:
                await self._notify_status("error", "Speech-to-text failed. Is Whisper running?")
                self._schedule_error_recovery()
            return
        if not text:
            print(f"[room:{self.room_name}] Transcription empty, skipping")
            if session:
                await self._notify_status("idle")
            return

        stripped = text.strip()
        # Normalize for comparison: lowercase, strip punctuation
        import re
        normalized = re.sub(r"[^\w\s\u266a\u266b\[\]()>]", "", stripped.lower()).strip()
        # Check exact match against known hallucinations
        if normalized in NOISE_EXACT or len(normalized) < 2:
            print(f"[room:{self.room_name}] Filtered noise transcription: {stripped!r}")
            if session:
                await self._notify_status("idle")
            return
        # Check substring match
        lower = stripped.lower()
        if any(sub in lower for sub in NOISE_SUBSTRINGS):
            print(f"[room:{self.room_name}] Filtered noise transcription (substring): {stripped!r}")
            if session:
                await self._notify_status("idle")
            return

        print(f"[room:{self.room_name}] Transcribed: {text}")

        if not session:
            print(f"[room:{self.room_name}] No Claude session found")
            return

        # Send user transcript to web client
        if self.notify_transcript_fn:
            try:
                await self.notify_transcript_fn(self.session_id, "user", text)
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
                print(f"[room:{self.room_name}] Forwarded to session '{session.name}'")
                self._waiting_for_response = True
                await self._notify_status("thinking", "Waiting for Claude...")
            except Exception as e:
                print(f"[room:{self.room_name}] Session WebSocket disconnected: {e}")
                await self.registry.unregister(self.session_id)

    async def handle_claude_response(self, text: str):
        """Called when Claude sends a text response. Stream-synthesize and play."""
        print(f"[room:{self.room_name}] Streaming TTS response: {text[:50]}...")

        if self._idle_timer and not self._idle_timer.done():
            self._idle_timer.cancel()
            self._idle_timer = None

        self._is_speaking = True
        await self._notify_status("speaking")
        try:
            total_samples = 0
            publish_start = time.time()
            got_audio = False

            try:
                async for pcm_chunk in audio_pipeline.synthesize_pcm_stream(text):
                    got_audio = True
                    total_samples += await self._publish_audio_chunk(pcm_chunk)
            except Exception as e:
                print(f"[room:{self.room_name}] Kokoro TTS stream error: {e}")
                if not got_audio:
                    await self._notify_status("error", "Text-to-speech failed. Is Kokoro running?")
                    self._schedule_error_recovery()
                    return

            if not got_audio:
                print(f"[room:{self.room_name}] TTS stream returned no audio")
                await self._notify_status("error", "Text-to-speech returned no audio.")
                self._schedule_error_recovery()
                return

            # Wait for remaining playback to finish
            playback_duration = total_samples / LIVEKIT_SAMPLE_RATE
            elapsed = time.time() - publish_start
            remaining = playback_duration - elapsed + 0.5
            if remaining > 0:
                await asyncio.sleep(remaining)

        finally:
            self._is_speaking = False
            self._speaking_ended_at = time.time()
            self._audio_buffer = []

            if self._pending_listening:
                self._pending_listening = None
                self._waiting_for_response = False
                self._current_activity = None
                await self._notify_status("idle")
            else:
                await self._notify_status("thinking", "Waiting for Claude...")
                self._idle_timer = asyncio.create_task(self._deferred_idle())

    async def _deferred_idle(self):
        """Fallback: transition to idle after timeout if no listening signal."""
        try:
            await asyncio.sleep(THINKING_TIMEOUT_S)
            print(f"[room:{self.room_name}] Thinking timeout — auto-transitioning to idle")
            self._waiting_for_response = False
            self._current_activity = None
            await self._notify_status("idle")
        except asyncio.CancelledError:
            pass

    async def handle_claude_listening(self):
        """Called when Claude enters relay_standby again — ready for next voice input."""
        if self._idle_timer and not self._idle_timer.done():
            self._idle_timer.cancel()
            self._idle_timer = None

        if self._is_speaking:
            self._pending_listening = self.session_id
            return

        self._waiting_for_response = False
        self._current_activity = None
        await self._notify_status("idle")

    async def handle_status_update(self, activity: str):
        """Called when Claude sends a status_update with current activity."""
        self._current_activity = activity
        await self._notify_status("thinking", activity=activity)

    def get_current_status(self) -> dict:
        return {"state": self._current_state, "activity": self._current_activity}

    async def _publish_audio_chunk(self, pcm_bytes: bytes) -> int:
        """Publish a PCM chunk to LiveKit. Returns the number of output samples published."""
        if not self.audio_source:
            return 0

        samples = np.frombuffer(pcm_bytes, dtype=np.int16)

        if SAMPLE_RATE != LIVEKIT_SAMPLE_RATE:
            from scipy import signal as scipy_signal
            samples = scipy_signal.resample(
                samples,
                int(len(samples) * LIVEKIT_SAMPLE_RATE / SAMPLE_RATE),
            ).astype(np.int16)

        frame_size = LIVEKIT_SAMPLE_RATE // 100  # 10ms frames
        for i in range(0, len(samples), frame_size):
            chunk = samples[i:i + frame_size]
            if len(chunk) < frame_size:
                chunk = np.pad(chunk, (0, frame_size - len(chunk)))

            frame = rtc.AudioFrame.create(LIVEKIT_SAMPLE_RATE, NUM_CHANNELS, frame_size)
            audio_data = np.frombuffer(frame.data, dtype=np.int16)
            np.copyto(audio_data, chunk)
            await self.audio_source.capture_frame(frame)

        return len(samples)

    async def _notify_status(self, state: str, activity: str | None = None):
        """Notify connected client of agent status change."""
        self._current_state = state
        self._current_activity = activity
        if self.notify_status_fn:
            try:
                await self.notify_status_fn(self.session_id, state, activity)
            except Exception:
                pass

    def _schedule_error_recovery(self):
        """Schedule auto-recovery from error state to idle."""
        if self._error_timer and not self._error_timer.done():
            self._error_timer.cancel()
        self._error_timer = asyncio.create_task(self._recover_from_error())

    async def _recover_from_error(self):
        """Auto-recover from error state after a delay."""
        try:
            await asyncio.sleep(ERROR_RECOVERY_S)
            print(f"[room:{self.room_name}] Error recovery — transitioning to idle")
            self._waiting_for_response = False
            self._current_activity = None
            await self._notify_status("idle")
        except asyncio.CancelledError:
            pass


class RelayAgent:
    """Manages per-session LiveKit rooms."""

    def __init__(self, registry, broadcast_fn, notify_status_fn=None, notify_transcript_fn=None):
        self.registry = registry
        self.broadcast_fn = broadcast_fn
        self.notify_status_fn = notify_status_fn
        self.notify_transcript_fn = notify_transcript_fn
        self._rooms: dict[str, SessionRoom] = {}  # session_id → SessionRoom

    async def add_session(self, session_id: str, room_name: str):
        """Create and start a LiveKit room for a new Claude session."""
        if session_id in self._rooms:
            return  # already exists

        room = SessionRoom(
            session_id=session_id,
            room_name=room_name,
            registry=self.registry,
            notify_status_fn=self.notify_status_fn,
            notify_transcript_fn=self.notify_transcript_fn,
        )
        self._rooms[session_id] = room
        await room.start()
        print(f"[agent] Added session room: {room_name}")

    async def remove_session(self, session_id: str):
        """Stop and remove a session's LiveKit room."""
        room = self._rooms.pop(session_id, None)
        if room:
            await room.stop()
            print(f"[agent] Removed session room: {room.room_name}")

    def get_room(self, session_id: str) -> SessionRoom | None:
        """Get the room for a session."""
        return self._rooms.get(session_id)

    async def handle_claude_response(self, session_id: str, text: str):
        room = self._rooms.get(session_id)
        if room:
            await room.handle_claude_response(text)

    async def handle_claude_listening(self, session_id: str):
        room = self._rooms.get(session_id)
        if room:
            await room.handle_claude_listening()

    async def handle_status_update(self, session_id: str, activity: str):
        room = self._rooms.get(session_id)
        if room:
            await room.handle_status_update(activity)

    def get_current_status(self, session_id: str) -> dict:
        room = self._rooms.get(session_id)
        if room:
            return room.get_current_status()
        return {"state": "idle", "activity": None}

    async def stop(self):
        """Stop all rooms."""
        for session_id in list(self._rooms.keys()):
            await self.remove_session(session_id)


def _to_wav(samples: np.ndarray, sample_rate: int) -> bytes:
    """Convert numpy int16 samples to WAV bytes."""
    buf = io.BytesIO()
    num_samples = len(samples)
    data_size = num_samples * 2

    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_size))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))
    buf.write(struct.pack("<H", 1))
    buf.write(struct.pack("<H", 1))
    buf.write(struct.pack("<I", sample_rate))
    buf.write(struct.pack("<I", sample_rate * 2))
    buf.write(struct.pack("<H", 2))
    buf.write(struct.pack("<H", 16))
    buf.write(b"data")
    buf.write(struct.pack("<I", data_size))
    buf.write(samples.tobytes())

    return buf.getvalue()
