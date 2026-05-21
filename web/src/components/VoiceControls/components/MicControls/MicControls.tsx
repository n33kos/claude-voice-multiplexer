import { useEffect, useRef, useMemo, useCallback } from "react";
import type { MicMode } from "../../../../types/micMode";
import classNames from "classnames";
import {
  useRoomContext,
  useLocalParticipant,
  useTracks,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import { initAudio, playChime } from "../../../../hooks/useChime";
import { sessionHue } from "../../../../utils/sessionHue";
import { VoiceBar } from "../../../VoiceBar/VoiceBar";
import { useTrackAnalyser } from "../../hooks/useTrackAnalyser";
import { useWakeWord } from "../../../../wake-word/useWakeWord";
import type { MicControlsProps } from "../../VoiceControls.types";
import styles from "./MicControls.module.scss";

export function MicControls({
  sessionId,
  hueOverride,
  agentStatus,
  autoListen,
  speakerMuted,
  showStatusPill,
  wakeWordEnabled,
  wakeWordChime,
  wakeWordReloadKey,
  micMode,
  setMicMode,
  disableAutoListenSeq,
  onAutoListenChange,
  onSpeakerMutedChange,
  onInterrupt,
  onTerminalOpen,
  particleAnalyserRef,
}: MicControlsProps) {
  const room = useRoomContext();
  const { isMicrophoneEnabled } = useLocalParticipant();
  const hue = hueOverride != null ? hueOverride : (sessionId ? sessionHue(sessionId) : null);

  // micMode is owned by App so useChime and VoiceBar share the same
  // source of truth.

  // Drop out of wake mode if the feature is turned off.
  useEffect(() => {
    if (!wakeWordEnabled && micMode === "wake") {
       
      setMicMode("muted");
    }
  }, [wakeWordEnabled, micMode]);

  // Honor explicit Settings "Auto-listen" toggles. Detect when autoListen
  // actually changes (not just a parent re-render) so we don't race with
  // our own outbound sync.
  const prevAutoListen = useRef(autoListen);
  useEffect(() => {
    if (prevAutoListen.current === autoListen) return;
    prevAutoListen.current = autoListen;
    if (agentStatus.state !== "idle") return;
    if (autoListen && micMode !== "active") setMicMode("active");
    else if (!autoListen && micMode === "active") setMicMode("muted");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoListen, agentStatus.state]);

  // Persist mic state TO the autoListen setting so the next session boots
  // into the user's last chosen state.
  useEffect(() => {
    const next = micMode === "active";
    if (next !== autoListen) onAutoListenChange(next);
  }, [micMode, autoListen, onAutoListenChange]);

  // Track the last non-active mode so silence/timeout restores whichever
  // posture the user came from (wake vs muted).
  const lastInactiveMode = useRef<MicMode>(micMode === "active" ? "muted" : micMode);
  useEffect(() => {
    if (micMode !== "active") lastInactiveMode.current = micMode;
  }, [micMode]);

  // Server-side silence detection sequence + the local fallback timer
  // both restore lastInactiveMode.
  const prevSilenceSeq = useRef(disableAutoListenSeq);
  const INACTIVITY_MS = 5000;

  // Suspend wake-word matching whenever Claude is speaking or thinking.
  const suspendWake = agentStatus.state === "speaking" || agentStatus.state === "thinking";

  const onWakeMatch = useCallback(() => {
    if (wakeWordChime) playChime();
    setMicMode("active");
  }, [wakeWordChime]);

  const wake = useWakeWord({
    enabled: wakeWordEnabled,
    active: wakeWordEnabled && micMode === "wake",
    suspend: suspendWake,
    onMatch: onWakeMatch,
  });

  // Re-read templates whenever the parent bumps the key (e.g. after enrollment).
  // IMPORTANT: depend only on the stable `reload` ref, not on `wake` itself —
  // `wake` is a fresh object each render and would loop the effect.
  const wakeReload = wake.reload;
  useEffect(() => { void wakeReload(); }, [wakeWordReloadKey, wakeReload]);

  // Apply the silence-detected signal once per increment. Restore whichever
  // posture the user was in before unmuting (wake or muted).
  useEffect(() => {
    if (disableAutoListenSeq === prevSilenceSeq.current) return;
    prevSilenceSeq.current = disableAutoListenSeq;
    if (micMode !== "active") return;
    setMicMode(lastInactiveMode.current);
    void room.localParticipant.setMicrophoneEnabled(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disableAutoListenSeq]);

  // Switching sessions while in "active" carries the open mic into the
  // new session and bypasses the wake-word flow. Reset to the armed-rest
  // posture (wake if available, else muted) on any real session change.
  const prevSessionId = useRef(sessionId ?? null);
  useEffect(() => {
    const next = sessionId ?? null;
    const prev = prevSessionId.current;
    prevSessionId.current = next;
    if (next === prev) return;
    if (next === null) return;
    if (micMode !== "active") return;
    const wakeArmed = wakeWordEnabled && wake.hasTemplates;
    setMicMode(wakeArmed ? "wake" : "muted");
    void room.localParticipant.setMicrophoneEnabled(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Session-colored overrides for thinking/speaking states
  const sessionPillStyle = useMemo(() => {
    if (hue === null) return undefined;
    return {
      backgroundColor: `hsla(${hue}, 55%, 50%, 0.15)`,
      borderColor: `hsla(${hue}, 55%, 50%, 0.3)`,
      color: `hsla(${hue}, 70%, 70%, 1)`,
    };
  }, [hue]);

  const sessionButtonStyle = useMemo(() => {
    if (hue === null) return undefined;
    return {
      backgroundColor: `hsla(${hue}, 55%, 50%, 0.2)`,
      borderColor: `hsla(${hue}, 55%, 50%, 0.4)`,
    };
  }, [hue]);

  const sessionIconColor = hue !== null ? `hsla(${hue}, 70%, 70%, 1)` : undefined;

  // Convert session hue to RGB for VoiceBar
  const sessionRgb = useMemo(() => {
    if (hue === null) return undefined;
    const s = 0.55, l = 0.55;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (hue < 60) { r = c; g = x; }
    else if (hue < 120) { r = x; g = c; }
    else if (hue < 180) { g = c; b = x; }
    else if (hue < 240) { g = x; b = c; }
    else if (hue < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255),
    };
  }, [hue]);

  const agentState = agentStatus.state;

  const allTracks = useTracks([Track.Source.Microphone]);
  const localTrackRef = allTracks.find((t) => t.participant.isLocal);
  const remoteTrackRef = allTracks.find((t) => !t.participant.isLocal);

  const localMediaTrack = localTrackRef?.publication.track?.mediaStreamTrack;
  const remoteMediaTrack = remoteTrackRef?.publication.track?.mediaStreamTrack;

  const localAnalyser = useTrackAnalyser(localMediaTrack);
  const remoteAnalyser = useTrackAnalyser(remoteMediaTrack);

  // Client-side inactivity fallback. Polls the local mic analyser and
  // only fires after INACTIVITY_MS of CONTINUOUS silence (RMS below
  // threshold). Speaking or any detectable audio resets the counter.
  // Covers the hardware-mute / dead-quiet case where the server-side
  // silence signal never fires because VAD never sees any speech.
  useEffect(() => {
    if (micMode !== "active") return;
    if (agentStatus.state !== "idle") return;
    const SILENCE_RMS_THRESHOLD = 0.01;
    const tickMs = 200;
    let silentMs = 0;
    const id = window.setInterval(() => {
      const a = localAnalyser.current;
      let rms = 0;
      if (a) {
        const buf = new Float32Array(a.fftSize);
        a.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        rms = Math.sqrt(sum / buf.length);
      }
      if (rms > SILENCE_RMS_THRESHOLD) {
        silentMs = 0;
        return;
      }
      silentMs += tickMs;
      if (silentMs >= INACTIVITY_MS) {
        window.clearInterval(id);
        setMicMode(lastInactiveMode.current);
        void room.localParticipant.setMicrophoneEnabled(false);
      }
    }, tickMs);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micMode, agentStatus.state, localAnalyser]);

  const isMicActive = !!isMicrophoneEnabled && agentState === "idle";
  const activeAnalyser =
    agentState === "speaking" ? remoteAnalyser : localAnalyser;

  useEffect(() => {
    if (!particleAnalyserRef) return;
    particleAnalyserRef.current = activeAnalyser.current;
    const id = setInterval(() => {
      if (particleAnalyserRef) particleAnalyserRef.current = activeAnalyser.current;
    }, 100);
    return () => clearInterval(id);
  }, [activeAnalyser, particleAnalyserRef]);

  const prevAgentState = useRef(agentState);
  useEffect(() => {
    const stateChanged = prevAgentState.current !== agentState;
    prevAgentState.current = agentState;

    if (agentState === "idle") {
      // Stay in whatever mode the user is in — active across multiple
      // turns; the only thing that knocks us out is silence detection.
      room.localParticipant.setMicrophoneEnabled(micMode === "active");
    } else if (stateChanged && (agentState === "thinking" || agentState === "speaking")) {
      room.localParticipant.setMicrophoneEnabled(false);
    }
  }, [agentState, micMode, room.localParticipant]);

  const muteRemoteAudio = () => {
    const t = remoteTrackRef?.publication?.track as
      | { setVolume?: (v: number) => void }
      | undefined;
    t?.setVolume?.(0);
  };

  useEffect(() => {
    if (agentState !== "speaking") return;
    const t = remoteTrackRef?.publication?.track as
      | { setVolume?: (v: number) => void }
      | undefined;
    t?.setVolume?.(1);
  }, [agentState, remoteTrackRef]);

  const toggleMic = async () => {
    initAudio();
    // Escape hatch during speaking/thinking: always force active.
    if (agentState === "speaking" || agentState === "thinking") {
      muteRemoteAudio();
      onInterrupt();
      setMicMode("active");
      await room.localParticipant.setMicrophoneEnabled(true);
      return;
    }
    if (agentState !== "idle") return;

    const wakeAvailable = wakeWordEnabled && wake.hasTemplates;

    // Cycle: muted → wake → active → muted (wake step skipped if unavailable).
    let next: MicMode;
    if (micMode === "muted") next = wakeAvailable ? "wake" : "active";
    else if (micMode === "wake") next = "active";
    else next = "muted";

    console.log("[mic]", micMode, "→", next);
    setMicMode(next);
    // Sync the LiveKit mic synchronously to avoid UI flicker.
    await room.localParticipant.setMicrophoneEnabled(next === "active");
  };

  useEffect(() => {
    const handler = (e: CustomEvent) => {
      if (e.detail?.type === 'toggle-mic') toggleMic();
    };
    document.addEventListener('vmux:command', handler as EventListener);
    return () => document.removeEventListener('vmux:command', handler as EventListener);
  }, [toggleMic]);

  const toggleSpeaker = () => {
    initAudio();
    onSpeakerMutedChange(!speakerMuted);
  };

  const pillStyle = (() => {
    switch (agentState) {
      case "thinking":
        return {
          className: styles.StatusPillThinking,
          label: agentStatus.activity || "Processing...",
        };
      case "speaking":
        return { className: styles.StatusPillSpeaking, label: "Speaking" };
      case "error":
        return {
          className: styles.StatusPillError,
          label: agentStatus.activity || "Error",
        };
      default:
        if (micMode === "wake") {
          return { className: styles.StatusPillWake, label: 'Say "hey claude"' };
        }
        return micMode === "active"
          ? { className: styles.StatusPillListening, label: "Listening" }
          : { className: styles.StatusPillIdle, label: "Idle" };
    }
  })();

  // While Claude is thinking or speaking the mic is force-disabled, so
  // visually treat the button as muted regardless of the underlying
  // micMode — keeps the red/yellow indicator honest about whether we
  // are actually recording.
  const micEffectivelyOff = agentState !== "idle";
  const micButtonClass =
    micEffectivelyOff ? styles.MicButtonInactive
    : micMode === "wake" ? styles.MicButtonWake
    : micMode === "active" ? styles.MicButtonActive
    : styles.MicButtonInactive;

  const micIconClass =
    micEffectivelyOff ? styles.MicIconInactive
    : micMode === "wake" ? styles.MicIconWake
    : micMode === "active" ? styles.MicIconActive
    : styles.MicIconInactive;

  return (
    <div data-component="VoiceControls" className={styles.Root}>
      {showStatusPill && (
        <div
          className={classNames(styles.StatusPill, pillStyle.className)}
          style={(agentState === "thinking" || agentState === "speaking") ? sessionPillStyle : undefined}
        >
          <span
            className={classNames(styles.StatusDot, {
              [styles.StatusDotPulse]: agentState === "thinking" || micMode === "wake",
            })}
          />
          <span className={styles.StatusLabel}>{pillStyle.label}</span>
        </div>
      )}

      <VoiceBar
        agentStatus={agentStatus}
        isMicEnabled={isMicActive}
        analyserRef={activeAnalyser}
        sessionColor={sessionRgb}
      />
      <div className={styles.ButtonRow}>
        <button
          onClick={onTerminalOpen}
          className={classNames(styles.CircleButton, styles.TerminalButton)}
          title="Open terminal"
        >
          <svg className={styles.ButtonIcon} viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M2 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm3.293 1.293a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 01-1.414-1.414L7.586 10 5.293 7.707a1 1 0 010-1.414zM11 12a1 1 0 100 2h3a1 1 0 100-2h-3z"
              clipRule="evenodd"
            />
          </svg>
        </button>
        <button
          onClick={toggleMic}
          className={classNames(styles.CircleButton, micButtonClass)}
          title={
            micMode === "wake"
              ? 'Wake-word listening — say "hey claude" to unmute'
              : micMode === "active" ? "Mute" : "Unmute"
          }
        >
          <svg
            className={classNames(styles.ButtonIcon, micIconClass)}
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            {micMode !== "muted" ? (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
              />
            ) : (
              <>
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
                />
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
              </>
            )}
          </svg>
        </button>
        <button
          onClick={toggleSpeaker}
          className={classNames(
            styles.CircleButton,
            speakerMuted
              ? styles.SpeakerButtonInactive
              : styles.SpeakerButtonActive,
          )}
          style={!speakerMuted ? sessionButtonStyle : undefined}
        >
          <svg
            className={classNames(
              styles.ButtonIcon,
              speakerMuted
                ? styles.SpeakerIconInactive
                : styles.SpeakerIconActive,
            )}
            style={!speakerMuted && sessionIconColor ? { color: sessionIconColor } : undefined}
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            {speakerMuted ? (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6l4.72-3.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-3.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
              />
            ) : (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-3.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-3.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
              />
            )}
          </svg>
        </button>
      </div>
    </div>
  );
}
