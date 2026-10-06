import test from 'node:test';
import assert from 'node:assert/strict';
import {RealtimeTurnBuffer,needsMoreSpeech} from '../lib/realtime-turn-buffer.ts';

function fakeTimers(){
 let now=0,nextId=0;
 const tasks=new Map();
 return {
  set(callback,delayMs){const id=++nextId;tasks.set(id,{at:now+delayMs,callback});return id},
  clear(id){tasks.delete(id)},
  advance(ms){
   const until=now+ms;
   for(;;){
    const due=[...tasks.entries()].filter(([,task])=>task.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];
    if(!due)break;
    now=due[1].at;tasks.delete(due[0]);due[1].callback();
   }
   now=until;
  },
 };
}

test('partial text and stash are replaced, then only the completed transcript is submitted',()=>{
 const turns=new RealtimeTurnBuffer();
 assert.equal(turns.partial('item-1','','周一两点'),'周一两点');
 assert.equal(turns.partial('item-1','周一','三点'),'周一三点');
 assert.equal(turns.complete('item-1','周一三点'),true);
 assert.equal(turns.flush(),'周一三点');
 assert.equal(turns.complete('item-1','周一三点'),false);
 assert.equal(turns.flush(),'');
});

test('adjacent completed items form one corrected human turn',()=>{
 const turns=new RealtimeTurnBuffer();
 turns.complete('item-1','周一两点安排原型。');
 turns.partial('item-2','不对，','三点');
 assert.equal(turns.preview(),'周一两点安排原型。 不对，三点');
 turns.complete('item-2','不对，三点。');
 assert.equal(turns.flush(),'周一两点安排原型。 不对，三点。');
});

test('failed recognition never becomes an executable turn',()=>{
 const turns=new RealtimeTurnBuffer();
 turns.partial('item-1','','删掉那个项目');
 assert.equal(turns.failed('item-1'),'');
 assert.equal(turns.flush(),'');
});

test('a failed correction discards the preceding fragment instead of executing a truncated command',()=>{
 const timers=fakeTimers(),sent=[];
 const turns=new RealtimeTurnBuffer({quietMs:4000,timers,onReady:()=>sent.push(turns.flush())});
 turns.complete('first','把周三的课表删掉。');
 timers.advance(2000);
 turns.speechStarted('correction');
 turns.partial('correction','不对，','先别删');
 assert.equal(turns.failed('correction'),'');
 timers.advance(6000);
 assert.deepEqual(sent,[]);
 assert.equal(turns.flush(),'');
 turns.complete('repeat','先别删，帮我看一下课表。');
 assert.equal(turns.failed('correction'),'先别删，帮我看一下课表。','a duplicate failure must not discard later speech');
 timers.advance(4000);
 assert.deepEqual(sent,['先别删，帮我看一下课表。']);
});

test('a new speech start cancels an older completed item before its quiet timer fires',()=>{
 const timers=fakeTimers(),sent=[];
 const turns=new RealtimeTurnBuffer({quietMs:4000,timers,onReady:()=>sent.push(turns.flush())});
 turns.speechStarted('first');
 turns.complete('first','明天两点约张老师。');
 timers.advance(1800);
 turns.speechStarted('correction');
 timers.advance(5000);
 assert.deepEqual(sent,[],'the first fragment must not execute while the person is speaking again');
 turns.partial('correction','不对，','改到三点');
 timers.advance(5000);
 assert.deepEqual(sent,[],'a partial correction must still block submission');
 turns.complete('correction','不对，改到三点。');
 timers.advance(3999);
 assert.deepEqual(sent,[]);
 timers.advance(1);
 assert.deepEqual(sent,['明天两点约张老师。 不对，改到三点。']);
});

test('a delta alone cancels the pending submission and awaits its final transcript',()=>{
 const timers=fakeTimers(),sent=[];
 const turns=new RealtimeTurnBuffer({quietMs:4000,timers,onReady:()=>sent.push(turns.flush())});
 turns.complete('first','先做首页。');
 timers.advance(2000);
 turns.partial('second','等等，','先做登录');
 timers.advance(7000);
 assert.deepEqual(sent,[]);
 turns.complete('second','等等，先做登录。');
 timers.advance(4000);
 assert.deepEqual(sent,['先做首页。 等等，先做登录。']);
});

test('transcripts retain speech order even when completion events arrive out of order',()=>{
 const turns=new RealtimeTurnBuffer();
 turns.speechStarted('first');
 turns.speechStarted('second');
 turns.complete('second','后来改成三点。');
 turns.complete('first','原来约了两点。');
 assert.equal(turns.flush(),'原来约了两点。 后来改成三点。');
});

test('an ASR full stop cannot turn "你好，我要。" into an executable instruction',()=>{
 const timers=fakeTimers(),sent=[];
 const turns=new RealtimeTurnBuffer({quietMs:4000,timers,onReady:()=>sent.push(turns.flush())});
 turns.complete('first','你好，我要。');
 assert.equal(needsMoreSpeech('你好，我要。'),true);
 assert.equal(turns.hasIncompleteCandidate(),true);
 timers.advance(20000);
 assert.deepEqual(sent,[]);
 assert.equal(turns.preview(),'你好，我要。');
 turns.speechStarted('next');
 turns.partial('next','呃，先帮我','安排一下课表吧');
 timers.advance(5000);
 assert.deepEqual(sent,[]);
 turns.complete('next','呃，先帮我安排一下课表吧。');
 assert.equal(turns.hasIncompleteCandidate(),false);
 timers.advance(4000);
 assert.deepEqual(sent,['你好，我要。 呃，先帮我安排一下课表吧。']);
});

test('an incomplete correction or unfinished partial requires review at call end',()=>{
 const turns=new RealtimeTurnBuffer();
 turns.complete('first','周五两点开会。');
 turns.speechStarted('second');
 turns.partial('second','不对，','周四');
 assert.equal(turns.hasUnfinished(),true);
 assert.equal(turns.preview(),'周五两点开会。 不对，周四');
});

test('an invalid filler does not strand a completed candidate behind a pending item',()=>{
 const timers=fakeTimers(),sent=[];
 const turns=new RealtimeTurnBuffer({quietMs:4000,timers,onReady:()=>sent.push(turns.flush())});
 turns.complete('real','明天下午开会。');
 timers.advance(1700);
 turns.speechStarted('filler');
 timers.advance(5000);
 assert.deepEqual(sent,[]);
 turns.invalid('filler');
 timers.advance(4000);
 assert.deepEqual(sent,['明天下午开会。']);
});
