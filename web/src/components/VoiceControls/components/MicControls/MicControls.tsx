import { useEffect, useRef } from "react";
import classNames from "classnames";
import {
  useRoomContext,
  useLocalParticipant,
  useTracks,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import { initAudio } from "../../../../hooks/useChime";
import { VoiceBar } from "../../../VoiceBar/VoiceBar";
import { useTrackAnalyser } from "../../hooks/useTrackAnalyser";
import type { MicControlsProps } from "../../VoiceControls.types";
import styles from "./MicControls.module.scss";

export function MicControls({
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
    const prev = prevAgentState.current;
    prevAgentState.current = agentState;
    if (prev === agentState) return;

    if (agentState === "idle") {
      room.localParticipant.setMicrophoneEnabled(autoListen);
    } else if (agentState === "thinking" || agentState === "speaking") {
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
        return { className: styles.StatusPillThinking, label: agentStatus.activity || "Processing..." };
      case "speaking":
        return { className: styles.StatusPillSpeaking, label: "Speaking" };
      case "error":
        return { className: styles.StatusPillError, label: agentStatus.activity || "Error" };
      default:
        return autoListen
          ? { className: styles.StatusPillListening, label: "Listening" }
          : { className: styles.StatusPillIdle, label: "Idle" };
    }
  })();

  return (
    <div data-component="VoiceControls" className={styles.Root}>
      {showStatusPill && (
        <div className={classNames(styles.StatusPill, pillStyle.className)}>
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
            className={classNames(styles.ButtonIcon, autoListen ? styles.MicIconActive : styles.MicIconInactive)}
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
        <button
          onClick={toggleSpeaker}
          className={classNames(
            styles.CircleButton,
            speakerMuted ? styles.SpeakerButtonInactive : styles.SpeakerButtonActive,
          )}
        >
          <svg
            className={classNames(styles.ButtonIcon, speakerMuted ? styles.SpeakerIconInactive : styles.SpeakerIconActive)}
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
        {showInterrupt && (
          <button
            onClick={() => {
              initAudio();
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
      </div>
    </div>
  );
}
