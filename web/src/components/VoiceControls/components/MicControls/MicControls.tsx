import { useEffect, useRef } from "react";
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

  const statusPill = (() => {
    switch (agentState) {
      case "thinking":
        return {
          bg: "bg-purple-500/15",
          border: "border-purple-500/30",
          text: "text-purple-400",
          dot: "bg-purple-400",
          label: agentStatus.activity || "Processing...",
        };
      case "speaking":
        return {
          bg: "bg-blue-500/15",
          border: "border-blue-500/30",
          text: "text-blue-400",
          dot: "bg-blue-400",
          label: "Speaking",
        };
      case "error":
        return {
          bg: "bg-amber-500/15",
          border: "border-amber-500/30",
          text: "text-amber-400",
          dot: "bg-amber-400",
          label: agentStatus.activity || "Error",
        };
      default:
        return autoListen
          ? {
              bg: "bg-red-500/10",
              border: "border-red-500/30",
              text: "text-red-400",
              dot: "bg-red-400",
              label: "Listening",
            }
          : {
              bg: "bg-neutral-500/10",
              border: "border-neutral-700",
              text: "text-neutral-500",
              dot: "bg-neutral-500",
              label: "Idle",
            };
    }
  })();

  return (
    <div data-component="VoiceControls" className="flex flex-col items-center gap-3 w-full">
      {showStatusPill && (
        <div
          className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs ${statusPill.bg} border ${statusPill.border} ${statusPill.text} transition-all duration-300`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${statusPill.dot} ${agentState === "thinking" ? "animate-pulse" : ""}`}
          />
          <span className="truncate max-w-48">{statusPill.label}</span>
        </div>
      )}

      <VoiceBar
        agentStatus={agentStatus}
        isMicEnabled={isMicActive}
        analyserRef={activeAnalyser}
      />
      <div className="flex items-center gap-3">
        {/* Mic button */}
        <button
          onClick={toggleMic}
          className={`
            w-12 h-12 rounded-full flex items-center justify-center transition-all
            ${
              autoListen
                ? "bg-red-500/20 border border-red-500/40 active:bg-red-500/30"
                : "bg-neutral-800 border border-neutral-700 active:bg-neutral-700"
            }
          `}
        >
          <svg
            className={`w-5 h-5 ${autoListen ? "text-red-400" : "text-neutral-400"}`}
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
        {/* Speaker button */}
        <button
          onClick={toggleSpeaker}
          className={`
            w-12 h-12 rounded-full flex items-center justify-center transition-all
            ${
              speakerMuted
                ? "bg-neutral-800 border border-neutral-700 active:bg-neutral-700"
                : "bg-blue-500/20 border border-blue-500/40 active:bg-blue-500/30"
            }
          `}
        >
          <svg
            className={`w-5 h-5 ${speakerMuted ? "text-neutral-400" : "text-blue-400"}`}
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
        {/* Interrupt button */}
        {showInterrupt && (
          <button
            onClick={() => {
              initAudio();
              onInterrupt();
            }}
            className="w-12 h-12 rounded-full flex items-center justify-center transition-all bg-amber-500/20 border border-amber-500/40 active:bg-amber-500/30"
          >
            <svg
              className="w-5 h-5 text-amber-400"
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
