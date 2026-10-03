import test from 'node:test';
import assert from 'node:assert/strict';
import {nextEndDrainAction} from '../lib/continuous-voice-drain.ts';
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

function pending(scope, id, size) { return {key: pendingVoiceKey(scope, id), scope, id, size, createdAt: '2026-10-04T00:00:00Z'}; }

test('failed recordings are scoped and bounded without evicting earlier clips', () => {
  assert.notEqual(pendingVoiceKey('alpha', 'turn-1'), pendingVoiceKey('beta', 'turn-1'));
  const eight = Array.from({length: MAX_PENDING_VOICE_TURNS}, (_, index) => pending('alpha', `turn-${index}`, 100));
  assert.equal(canStorePendingVoice(eight, pending('alpha', 'new', 100)), false);
  assert.equal(canStorePendingVoice(eight, pending('alpha', 'turn-0', 200)), true);
  assert.equal(canStorePendingVoice([], pending('alpha', 'huge', MAX_PENDING_VOICE_BYTES + 1)), false);
});
