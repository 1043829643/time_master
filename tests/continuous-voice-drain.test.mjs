import test from 'node:test';
import assert from 'node:assert/strict';
import {completeVoiceGroup, nextEndDrainAction, remainingVoiceTurnQuietMs, voiceGroupPartId, voiceTurnNeedsContinuation, voiceTurnQuietMs, VOICE_TURN_QUIET_MS} from '../lib/continuous-voice-drain.ts';
import {canStorePendingVoice, MAX_PENDING_VOICE_BYTES, MAX_PENDING_VOICE_TURNS, pendingVoiceKey} from '../lib/continuous-voice-recovery.ts';

const state = (values = {}) => ({ending: true, closed: false, recording: false, recorderStopping: false, recognizing: false, queuedClips: 0, delivering: false, saving: 0, pendingText: false, ...values});

test('end waits for the final recorder event, queued ASR, persistence, and callback', () => {
  assert.equal(nextEndDrainAction(state({recording: true})), 'wait');
  assert.equal(nextEndDrainAction(state({recorderStopping: true})), 'wait');
  assert.equal(nextEndDrainAction(state({queuedClips: 1})), 'wait');
  assert.equal(nextEndDrainAction(state({recognizing: true})), 'wait');
  assert.equal(nextEndDrainAction(state({saving: 1})), 'wait');
  assert.equal(nextEndDrainAction(state({pendingText: true})), 'deliver');
  assert.equal(nextEndDrainAction(state({delivering: true})), 'wait');
  assert.equal(nextEndDrainAction(state()), 'finish');
});

test('drain does not run on ordinary live capture or a cancelled session', () => {
  assert.equal(nextEndDrainAction(state({ending: false})), 'wait');
  assert.equal(nextEndDrainAction(state({closed: true, pendingText: true})), 'wait');
});

test('a natural correction stays in the same turn beyond the ASR clip boundary', () => {
  assert.equal(voiceTurnQuietMs('明天下午两点安排评审。'), VOICE_TURN_QUIET_MS);
  assert.equal(remainingVoiceTurnQuietMs('明天下午两点安排评审。', 1000, 3900), VOICE_TURN_QUIET_MS - 2900);
  assert.equal(remainingVoiceTurnQuietMs('明天下午两点安排评审。 不对，改成', 1000, 3900), Number.POSITIVE_INFINITY);
});

test('a dangling phrase never auto-submits, even if ASR adds a full stop', () => {
  for (const phrase of ['你好，我要。', '帮我把', '先安排在', '不对，', '明天还有', '我想', '联系人改成']) {
    assert.equal(voiceTurnNeedsContinuation(phrase), true, phrase);
    assert.equal(voiceTurnQuietMs(phrase), Number.POSITIVE_INFINITY, phrase);
  }
  assert.equal(remainingVoiceTurnQuietMs('你好，我要。', 1000, 20000), Number.POSITIVE_INFINITY);
  assert.equal(voiceTurnNeedsContinuation('你好，我要。 呃，先帮我安排一下课表吧。'), false);
  assert.equal(voiceTurnQuietMs('你好，我要。 呃，先帮我安排一下课表吧。'), VOICE_TURN_QUIET_MS);
});

test('a failed ASR clip cannot be retried as a partial command', () => {
  const ids = [0, 1, 2].map(index => voiceGroupPartId('turn-1', 3, index));
  assert.equal(completeVoiceGroup(ids), true);
  assert.equal(completeVoiceGroup([ids[0], ids[2]]), false);
  assert.equal(completeVoiceGroup([ids[0], ids[1], ids[1]]), false);
  assert.equal(completeVoiceGroup([ids[0], ids[1], voiceGroupPartId('turn-2', 3, 2)]), false);
});

function pending(scope, id, size) { return {key: pendingVoiceKey(scope, id), scope, id, size, createdAt: '2026-10-04T00:00:00Z'}; }

test('failed recordings are scoped and bounded without evicting earlier clips', () => {
  assert.notEqual(pendingVoiceKey('alpha', 'turn-1'), pendingVoiceKey('beta', 'turn-1'));
  const eight = Array.from({length: MAX_PENDING_VOICE_TURNS}, (_, index) => pending('alpha', `turn-${index}`, 100));
  assert.equal(canStorePendingVoice(eight, pending('alpha', 'new', 100)), false);
  assert.equal(canStorePendingVoice(eight, pending('alpha', 'turn-0', 200)), true);
  assert.equal(canStorePendingVoice([], pending('alpha', 'huge', MAX_PENDING_VOICE_BYTES + 1)), false);
});
