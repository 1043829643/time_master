import test from 'node:test';
import assert from 'node:assert/strict';
import {runAfterRecordingLock} from '../lib/recording-lock.ts';
import {recordingRecovery,transcriptAlreadyInDraft} from '../lib/recording-recovery.ts';

test('第二个标签页排队识别时先保留录音，锁释放后继续处理',async()=>{
 const events=[];
 let release;
 const held=new Promise(resolve=>{release=resolve});
 const lock=async run=>{events.push('waiting');await held;await run()};
 const processing=runAfterRecordingLock(
  ()=>events.push('retained'),lock,()=>true,async()=>{events.push('processed')},
 );
 assert.deepEqual(events,['retained','waiting']);
 release();await processing;
 assert.deepEqual(events,['retained','waiting','processed']);
});

test('等待锁期间取消后保留录音，但不再提交识别',async()=>{
 const events=[];
 let release,active=true;
 const held=new Promise(resolve=>{release=resolve});
 const processing=runAfterRecordingLock(
  ()=>events.push('retained'),async run=>{await held;await run()},()=>active,async()=>{events.push('processed')},
 );
 active=false;release();await processing;
 assert.deepEqual(events,['retained']);
});

test('另一页已交付的识别文字进入人工核对，不再自动识别或清理',()=>{
 const blob=new Blob(['recording']),createdAt='2026-10-03T00:00:00.000Z';
 assert.equal(recordingRecovery(null),'none');
 assert.equal(recordingRecovery({id:'r',blob,createdAt}),'retry');
 assert.equal(recordingRecovery({id:'r',blob,createdAt,transcript:'把会议改到周五',delivered:true}),'review');
});

test('清空输入后取回识别文字，不被旧录音编号错误去重',()=>{
 assert.equal(transcriptAlreadyInDraft('', '把会议改到周五','r','r','r'),false);
 assert.equal(transcriptAlreadyInDraft('把会议改到周五','把会议改到周五','r','r','r'),true);
 assert.equal(transcriptAlreadyInDraft('另一件事','把会议改到周五','r','r','r'),false);
});
