// Qwen-Audio 3.0 and Qwen3.8-Omni share the input transcript event names,
// but their session.update transcription fields are different.
export function realtimeSessionUpdate(model:string,eventId:string){
 const common={modalities:['text'],enable_search:false};
 if(model.startsWith('qwen-audio-'))return {
  type:'session.update',event_id:eventId,
  session:{...common,input_audio_format:'pcm',turn_detection:{type:'smart_turn'}},
 };
 return {
  type:'session.update',event_id:eventId,
  session:{...common,input_audio_transcription:{model:'qwen3-asr-flash-realtime'},turn_detection:{type:'semantic_vad',threshold:0.5,silence_duration_ms:1200}},
 };
}
