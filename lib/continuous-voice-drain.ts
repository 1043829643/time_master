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

/** A call may release the microphone while its last recording and ASR are still settling. */
export function nextEndDrainAction(state: EndDrainState): EndDrainAction {
  if (!state.ending || state.closed || state.recording || state.recorderStopping || state.recognizing || state.queuedClips || state.delivering || state.saving) return 'wait';
  return state.pendingText ? 'deliver' : 'finish';
}
