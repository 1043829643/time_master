export type VadState = {
  speaking: boolean;
  consecutiveVoice: number;
  candidateAt: number;
  startedAt: number;
  lastVoiceAt: number;
  noiseFloor: number;
};

export type VadEvent = 'none' | 'start' | 'finish' | 'limit';

export const VOICE_SAMPLE_MS = 50;
// A pause while thinking or correcting a date is common in natural speech.
// This is only an ASR clip boundary; it must not by itself submit a command.
export const VOICE_SILENCE_MS = 2800;
export const VOICE_MAX_TURN_MS = 42000;
export const VOICE_MIN_SPEECH_MS = 350;

export function initialVadState(noiseFloor = 0.004): VadState {
  return {speaking: false, consecutiveVoice: 0, candidateAt: 0, startedAt: 0, lastVoiceAt: 0, noiseFloor};
}

export function advanceVad(state: VadState, rms: number, now: number): {state: VadState; event: VadEvent; speechMs: number} {
  const level = Number.isFinite(rms) ? Math.max(0, rms) : 0;
  const threshold = Math.max(0.015, state.noiseFloor * 2.8);
  const isVoice = level >= (state.speaking ? threshold * 0.72 : threshold);
  if (!state.speaking) {
    if (!isVoice) {
      return {state: {...state, consecutiveVoice: 0, noiseFloor: Math.max(0.002, Math.min(0.016, state.noiseFloor * 0.96 + level * 0.04))}, event: 'none', speechMs: 0};
    }
    const consecutiveVoice = state.consecutiveVoice + 1;
    const candidateAt = state.consecutiveVoice ? state.candidateAt : now;
    if (consecutiveVoice < 2) return {state: {...state, consecutiveVoice, candidateAt}, event: 'none', speechMs: 0};
    return {state: {...state, speaking: true, consecutiveVoice: 0, startedAt: candidateAt, lastVoiceAt: now}, event: 'start', speechMs: 0};
  }
  const lastVoiceAt = isVoice ? now : state.lastVoiceAt;
  const speechMs = Math.max(0, lastVoiceAt - state.startedAt);
  if (now - state.startedAt >= VOICE_MAX_TURN_MS) {
    // Keep the speaking state across the recorder rotation. Resetting here
    // used to drop the first syllable of the next clip during long speech.
    return {state: {...initialVadState(state.noiseFloor), speaking: true, startedAt: now, lastVoiceAt: now}, event: 'limit', speechMs};
  }
  if (now - lastVoiceAt >= VOICE_SILENCE_MS) {
    return {state: initialVadState(state.noiseFloor), event: 'finish', speechMs};
  }
  return {state: {...state, lastVoiceAt}, event: 'none', speechMs};
}
