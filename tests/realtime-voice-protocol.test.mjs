import test from 'node:test';
import assert from 'node:assert/strict';
import {realtimeSessionUpdate} from '../lib/realtime-voice-protocol.ts';

test('Qwen-Audio 3.0 uses its own semantic turn config without Omni ASR model',()=>{
 const update=realtimeSessionUpdate('qwen-audio-3.0-realtime-plus','event_1');
 assert.equal(update.type,'session.update');
 assert.deepEqual(update.session.modalities,['text']);
 assert.equal(update.session.turn_detection.type,'smart_turn');
 assert.equal('input_audio_transcription' in update.session,false);
});

test('Qwen3.8 Omni enables the documented input transcription model',()=>{
 const update=realtimeSessionUpdate('qwen3.8-omni-flash-realtime','event_2');
 assert.deepEqual(update.session.input_audio_transcription,{model:'qwen3-asr-flash-realtime'});
 assert.equal(update.session.turn_detection.type,'semantic_vad');
 assert.deepEqual(update.session.modalities,['text']);
});
