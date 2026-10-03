import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceVad, initialVadState, VOICE_MAX_TURN_MS, VOICE_MIN_SPEECH_MS} from '../lib/continuous-voice-vad.ts';

function step(state, level, time) { return advanceVad(state, level, time); }

test('steady room noise does not open a voice turn', () => {
  let state = initialVadState();
  for (let time = 0; time < 3000; time += 50) {
    const next = step(state, 0.004, time);
    assert.equal(next.event, 'none');
    state = next.state;
  }
  assert.equal(state.speaking, false);
});

test('short spike is ignored; a spoken phrase ends after a pause', () => {
  let state = step(initialVadState(), 0.05, 0).state;
  assert.equal(state.speaking, false);
  state = step(state, 0.001, 50).state;
  assert.equal(state.speaking, false);
  let next = step(state, 0.05, 100); state = next.state;
  assert.equal(next.event, 'none');
  next = step(state, 0.05, 150); state = next.state;
  assert.equal(next.event, 'start');
  for (let time = 200; time <= 700; time += 50) state = step(state, 0.04, time).state;
  for (let time = 750; time < 2400; time += 50) {
    next = step(state, 0.001, time); state = next.state;
    assert.equal(next.event, 'none');
  }
  next = step(state, 0.001, 2400);
  assert.equal(next.event, 'finish');
  assert.ok(next.speechMs >= VOICE_MIN_SPEECH_MS);
  assert.equal(next.state.speaking, false);
});

test('a natural pause followed by a correction remains one turn', () => {
  let state = step(initialVadState(), 0.05, 0).state;
  state = step(state, 0.05, 50).state;
  for (let time = 100; time <= 500; time += 50) state = step(state, 0.05, time).state;
  for (let time = 550; time <= 1650; time += 50) {
    const next = step(state, 0.001, time);
    assert.equal(next.event, 'none');
    state = next.state;
  }
  const correction = step(state, 0.05, 1700);
  assert.equal(correction.event, 'none');
  assert.equal(correction.state.speaking, true);
});

test('a long utterance is bounded and another turn can begin', () => {
  let state = step(initialVadState(), 0.06, 0).state;
  let next = step(state, 0.06, 50); state = next.state;
  assert.equal(next.event, 'start');
  next = step(state, 0.06, VOICE_MAX_TURN_MS);
  assert.equal(next.event, 'limit');
  assert.equal(next.state.speaking, false);
  state = step(next.state, 0.06, VOICE_MAX_TURN_MS + 50).state;
  next = step(state, 0.06, VOICE_MAX_TURN_MS + 100);
  assert.equal(next.event, 'start');
});
