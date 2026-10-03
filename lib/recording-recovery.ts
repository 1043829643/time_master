import {type SavedRecording} from './recording-store.ts';

// A delivered transcript may only exist in another tab's session storage.
// Keep it visible until the user explicitly recovers or discards it.
export function recordingRecovery(value:SavedRecording|null){
 return !value?'none':value.delivered?'review':'retry';
}

export function transcriptAlreadyInDraft(draft:string,transcript:string,id:string,storedId:string|undefined,appliedId:string){
 return (storedId===id||appliedId===id)&&draft.includes(transcript);
}
