import test from 'node:test';
import assert from 'node:assert/strict';
import {RealtimeVoiceDrain} from '../lib/realtime-voice-drain.ts';
import {RealtimeTurnBuffer} from '../lib/realtime-turn-buffer.ts';

test('a final transcription arriving after Stop remains eligible for one complete turn',()=>{
 const drain=new RealtimeVoiceDrain(),turns=new RealtimeTurnBuffer();
 drain.speech('late');turns.partial('late','明天九点','开会');
 drain.begin();
 assert.equal(drain.awaitingFinal,true);
 assert.equal(drain.canSettle,false);
 assert.equal(turns.flush(),''); // partial speech is never executed
 drain.completed('late');turns.complete('late','明天九点开会');
 assert.equal(drain.canSettle,true);
 assert.equal(turns.flush(),'明天九点开会');
 assert.equal(turns.flush(),'');
});

test('a second unfinished item holds a stopped channel until its final or deadline',()=>{
 const drain=new RealtimeVoiceDrain(),turns=new RealtimeTurnBuffer();
 drain.speech('first');drain.speech('correction');drain.begin();
 drain.completed('first');turns.complete('first','两点安排。');
 assert.equal(drain.canSettle,false);
 turns.partial('correction','不对，','三点');
 assert.equal(turns.unfinishedPreview(),'不对，三点');
 assert.equal(turns.flush(),'两点安排。');
 assert.equal(turns.unfinishedPreview(),'不对，三点'); // tell user, never submit this fragment
 drain.completed('correction');turns.complete('correction','不对，三点。');
 assert.equal(drain.canSettle,true);
 assert.equal(turns.flush(),'不对，三点。');
});
