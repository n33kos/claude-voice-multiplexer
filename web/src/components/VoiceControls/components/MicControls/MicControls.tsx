import { useEffect, useRef, useMemo } from "react";
import classNames from "classnames";
import {
  useRoomContext,
  useLocalParticipant,
  useTracks,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import { initAudio } from "../../../../hooks/useChime";
import { sessionHue } from "../../../../utils/sessionHue";
import { VoiceBar } from "../../../VoiceBar/VoiceBar";
import { useTrackAnalyser } from "../../hooks/useTrackAnalyser";
import type { MicControlsProps } from "../../VoiceControls.types";
import styles from "./MicControls.module.scss";

export function MicControls({
  sessionId,
  agentStatus,
  autoListen,
  speakerMuted,
  showStatusPill,
  onAutoListenChange,
  onSpeakerMutedChange,
  onInterrupt,
}: MicControlsProps) {
  const room = useRoomContext();
  const { isMicrophoneEnabled } = useLocalParticipant();
  const hue = sessionId ? sessionHue(sessionId) : null;

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
    // HSL to RGB conversion (s=55%, l=55% for a vivid mid-tone)
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

  const isMicActive = !!isMicrophoneEnabled && agentState === "idle";
  const activeAnalyser =
    agentState === "speaking" ? remoteAnalyser : localAnalyser;

  const prevAgentState = useRef(agentState);
  useEffect(() => {
    const stateChanged = prevAgentState.current !== agentState;
    prevAgentState.current = agentState;

    if (agentState === "idle") {
      // Always sync mic with autoListen while idle — handles both
      // state transitions to idle AND autoListen toggling mid-idle.
      room.localParticipant.setMicrophoneEnabled(autoListen);
    } else if (stateChanged && (agentState === "thinking" || agentState === "speaking")) {
      room.localParticipant.setMicrophoneEnabled(false);
    }
  }, [agentState, autoListen, room.localParticipant]);

  const showInterrupt =
    agentState === "thinking" ||
    agentState === "speaking" ||
    agentState === "error";

  const toggleMic = async () => {
    initAudio();
    if (agentState === "idle") {
      const next = !isMicrophoneEnabled;
      await room.localParticipant.setMicrophoneEnabled(next);
      onAutoListenChange(next);
    } else {
      onAutoListenChange(!autoListen);
    }
  };

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
        return autoListen
          ? { className: styles.StatusPillListening, label: "Listening" }
          : { className: styles.StatusPillIdle, label: "Idle" };
    }
  })();

  return (
    <div data-component="VoiceControls" className={styles.Root}>
      {showStatusPill && (
        <div
          className={classNames(styles.StatusPill, pillStyle.className)}
          style={(agentState === "thinking" || agentState === "speaking") ? sessionPillStyle : undefined}
        >
          <span
            className={classNames(styles.StatusDot, {
              [styles.StatusDotPulse]: agentState === "thinking",
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
          onClick={toggleMic}
          className={classNames(
            styles.CircleButton,
            autoListen ? styles.MicButtonActive : styles.MicButtonInactive,
          )}
        >
          <svg
            className={classNames(
              styles.ButtonIcon,
              autoListen ? styles.MicIconActive : styles.MicIconInactive,
            )}
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
          >
            {autoListen ? (
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
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3 3l18 18"
                />
              </>
            )}
          </svg>
        </button>
        {showInterrupt && (
          <button
            onClick={async () => {
              initAudio();
              // Immediately enable mic (don't wait for React state/effect cycle)
              if (autoListen) {
                await room.localParticipant.setMicrophoneEnabled(true);
              }
              // Mute speaker so user gets feedback and can unmute when ready to hear response
              onSpeakerMutedChange(true);
              onInterrupt();
            }}
            className={classNames(styles.CircleButton, styles.InterruptButton)}
          >
            <svg
              className={classNames(styles.ButtonIcon, styles.InterruptIcon)}
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 9l6 6m0-6l-6 6"
              />
            </svg>
          </button>
        )}
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
