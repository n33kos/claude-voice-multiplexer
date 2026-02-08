import { useEffect, useRef } from 'react'
import type { AgentState, AgentStatus } from './useRelay'

let audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext()
  return audioCtx
}

/** Call this on a user gesture to unblock AudioContext */
export function initAudio() {
  const ctx = getAudioContext()
  if (ctx.state === 'suspended') ctx.resume()
}

function playTone(frequency: number, duration: number, volume = 0.3) {
  const ctx = getAudioContext()
  if (ctx.state === 'suspended') {
    ctx.resume().then(() => playTone(frequency, duration, volume))
    return
  }

  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.connect(gain)
  gain.connect(ctx.destination)

  osc.type = 'sine'
  osc.frequency.value = frequency
  // Must use setValueAtTime before exponentialRampToValueAtTime
  // otherwise the ramp start value is undefined
  gain.gain.setValueAtTime(volume, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration)

  osc.start(ctx.currentTime)
  osc.stop(ctx.currentTime + duration)
}

function playReadyChime() {
  // Ascending two-note: "ready to record"
  playTone(660, 0.15, 0.25)
  setTimeout(() => playTone(880, 0.18, 0.25), 120)
}

function playStoppedChime() {
  // Descending two-note: "recording captured, processing"
  playTone(880, 0.12, 0.25)
  setTimeout(() => playTone(660, 0.15, 0.25), 100)
}

export function useChime(agentStatus: AgentStatus) {
  const prevState = useRef<AgentState>(agentStatus.state)

  useEffect(() => {
    const prev = prevState.current
    prevState.current = agentStatus.state
    if (prev === agentStatus.state) return

    // Speaking → idle: mic re-enabled, ready to record
    if (prev === 'speaking' && agentStatus.state === 'idle') {
      playReadyChime()
    }

    // Idle → thinking: recording stopped, utterance captured
    if (prev === 'idle' && agentStatus.state === 'thinking') {
      playStoppedChime()
    }
  }, [agentStatus.state])
}
