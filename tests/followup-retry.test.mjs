import test from 'node:test';
import assert from 'node:assert/strict';
import {applyOperations,emptyData} from '../lib/domain.ts';
import {compareFollowupsByDue,rescheduleFollowup,submittedFollowupNote} from '../lib/daily-planning.ts';
import {captureBaseline,mergeChanges} from '../lib/changes.ts';

const at='2026-10-03T10:00';
const input=(notes,dueAt='2026-10-04T10:00')=>({notes,dueAt,contacted:true,blocksTask:false});

test('有确定时间的跟进排在无时间记录之前，逾期优先可见',()=>{
 const records=[{id:'undated',name:'没有约时间',dueAt:''},{id:'later',name:'后天联系',dueAt:'2026-10-05T10:00'},{id:'overdue',name:'昨天该问',dueAt:'2026-10-02T10:00'}];
 assert.deepEqual(records.sort(compareFollowupsByDue).map(x=>x.id),['overdue','later','undated']);
});

test('首次跟进记录没有前导空行，旧草稿的前导空行仍可识别',()=>{
 const fresh={id:'f',name:'等反馈',notes:'',dueAt:'',status:'waiting',projectId:'',taskId:'',contactId:'',blocksTask:false,lastContactAt:'',resolvedAt:'',createdAt:''};
 const op=rescheduleFollowup(fresh,input('已经联系'),at)[0];
 assert.equal(op.data.notes,at+' · 已经联系');
 assert.equal(submittedFollowupNote(fresh,op,at),'已经联系');
 assert.equal(submittedFollowupNote(fresh,{...op,data:{...op.data,notes:'\n'+at+' · 旧草稿'}},at),'旧草稿');
});

test('不确定保存后修改跟进结果，已提交文字与新补充都保留',()=>{
 const before=applyOperations(emptyData(),[{type:'followup.save',data:{id:'f',name:'等设计稿',notes:'初次联系'}}],'seed');
 const first=rescheduleFollowup(before.followups[0],input('先发了半张图'),at);
 const committed=applyOperations(before,first,'first');
 const previousNote=submittedFollowupNote(before.followups[0],first[0],at);
 assert.equal(previousNote,'先发了半张图');
 const second=rescheduleFollowup(committed.followups[0],input('余下的明天发','2026-10-05T11:00'),at,previousNote);
 const updated=applyOperations(committed,second,'second');
 assert.match(updated.followups[0].notes,/先发了半张图/);
 assert.match(updated.followups[0].notes,/余下的明天发/);
 assert.equal(updated.followups[0].dueAt,'2026-10-05T11:00');
 const onlyTime=rescheduleFollowup(committed.followups[0],input('先发了半张图','2026-10-05T11:00'),at,previousNote);
 assert.equal(onlyTime[0].data.notes,committed.followups[0].notes);
});

test('连续两次响应丢失后，同一改稿保持原操作，第三次改稿再追加一次',()=>{
 const seed=applyOperations(emptyData(),[{type:'followup.save',data:{id:'f',name:'等设计稿',notes:'初次联系'}}],'seed-2');
 const first=rescheduleFollowup(seed.followups[0],input('先发了半张图'),at);
 const afterFirst=applyOperations(seed,first,'first-2');
 const firstNote=submittedFollowupNote(seed.followups[0],first[0],at);
 const second=rescheduleFollowup(afterFirst.followups[0],input('余下的明天发','2026-10-05T11:00'),at,firstNote);
 const afterSecond=applyOperations(afterFirst,second,'second-2');
 const secondRetry=rescheduleFollowup(afterFirst.followups[0],input('余下的明天发','2026-10-05T11:00'),at,firstNote);
 assert.deepEqual(secondRetry,second,'相同表单应重放原操作编号，不能生成第三条记录');
 const third=rescheduleFollowup(afterSecond.followups[0],input('客户又补充了格式要求','2026-10-06T11:00'),at,'余下的明天发');
 const afterThird=applyOperations(afterSecond,third,'third-2');
 assert.equal((afterThird.followups[0].notes.match(/先发了半张图/g)||[]).length,1);
 assert.equal((afterThird.followups[0].notes.match(/余下的明天发/g)||[]).length,1);
 assert.equal((afterThird.followups[0].notes.match(/客户又补充了格式要求/g)||[]).length,1);
});

test('跨标签页同字段冲突后，以最新跟进重建基线可保留两边结果',()=>{
 const original=applyOperations(emptyData(),[{type:'followup.save',data:{id:'f',name:'等设计稿',notes:'初次联系'}}],'seed-3');
 const entered=input('我问了交付时间');
 const staleOps=rescheduleFollowup(original.followups[0],entered,at);
 const staleBase=captureBaseline(original,staleOps);
 const remote=applyOperations(original,rescheduleFollowup(original.followups[0],input('同事已经收到预览'),'2026-10-03T09:00'),'remote');
 assert.throws(()=>mergeChanges(remote,staleOps,staleBase));
 const refreshedOps=rescheduleFollowup(remote.followups[0],entered,at);
 const refreshedBase=captureBaseline(remote,refreshedOps);
 const saved=applyOperations(remote,mergeChanges(remote,refreshedOps,refreshedBase),'save-after-review');
 assert.match(saved.followups[0].notes,/同事已经收到预览/);
 assert.match(saved.followups[0].notes,/我问了交付时间/);
});
