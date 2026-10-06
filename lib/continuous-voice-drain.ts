export type EndDrainState = {
  ending: boolean;
  closed: boolean;
  recording: boolean;
  recorderStopping: boolean;
  recognizing: boolean;
  queuedClips: number;
  delivering: boolean;
  saving: number;
  pendingText: boolean;
};

export type EndDrainAction = 'wait' | 'deliver' | 'finish';

// The recorder's silence boundary is deliberately shorter than the boundary
// for a complete human turn. ASR may finish between "周二两点" and "不对，三点".
export const VOICE_TURN_QUIET_MS = 5000;

export function voiceTurnNeedsContinuation(text: string): boolean {
  const tail = text.trim().replace(/[，,。.!！？?；;、\s]+$/gu, '');
  // ASR often adds a full stop to a half-sentence. Its punctuation is not
  // evidence that the user has finished issuing an instruction.
  return /(?:不对|不是|等等|等下|哦不|啊不|然后|另外|但是|不过|因为|如果|或者|以及|并且|还有|先|再|把|将|给|和|跟|从|在|到|改成|挪到|移到|放到|我想|我要|需要|准备|那个|这个|嗯|呃|要|想)$/u.test(tail);
}

export function voiceTurnQuietMs(text: string): number {
  // Known incomplete clauses must wait for another phrase or manual review.
  // No timeout may turn "你好，我要。" into an executable instruction.
  return voiceTurnNeedsContinuation(text) ? Number.POSITIVE_INFINITY : VOICE_TURN_QUIET_MS;
}

export function remainingVoiceTurnQuietMs(text: string, lastVoiceAt: number, now: number): number {
  if (!Number.isFinite(lastVoiceAt) || !Number.isFinite(now)) return voiceTurnQuietMs(text);
  if (voiceTurnNeedsContinuation(text)) return Number.POSITIVE_INFINITY;
  return Math.max(0, voiceTurnQuietMs(text) - Math.max(0, now - lastVoiceAt));
}

export function voiceGroupPartId(groupId: string, total: number, index: number): string {
  return `voicegroup:${groupId}:${total}:${String(index).padStart(3, '0')}`;
}

export function parseVoiceGroupPartId(id: string): {groupId: string; total: number; index: number} | null {
  const match = /^voicegroup:([^:]+):(\d+):(\d+)$/.exec(id);
  if (!match) return null;
  const total = Number(match[2]), index = Number(match[3]);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(index) || total < 1 || index < 0 || index >= total) return null;
  return {groupId: match[1], total, index};
}

export function completeVoiceGroup(ids: string[]): boolean {
  if (!ids.length) return false;
  const first = parseVoiceGroupPartId(ids[0]);
  if (!first || ids.length !== first.total) return false;
  const indices = ids.map(parseVoiceGroupPartId);
  return indices.every(part => part?.groupId === first.groupId && part.total === first.total)
    && new Set(indices.map(part => part!.index)).size === first.total;
}

/** A call may release the microphone while its last recording and ASR are still settling. */
export function nextEndDrainAction(state: EndDrainState): EndDrainAction {
  if (!state.ending || state.closed || state.recording || state.recorderStopping || state.recognizing || state.queuedClips || state.delivering || state.saving) return 'wait';
  return state.pendingText ? 'deliver' : 'finish';
}
