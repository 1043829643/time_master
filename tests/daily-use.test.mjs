import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyData,applyOperations,addDays,localDay} from '../lib/domain.ts';
import {makeDayPlan,convertCapture,completeFollowup} from '../lib/daily-planning.ts';
import {taskBlockers} from '../lib/planning.ts';
import {captureBaseline,mergeChanges} from '../lib/changes.ts';
import {parseBackup,restorePlan,exportBackup} from '../lib/backup.ts';
import {followupCalendar} from '../lib/calendar-export.ts';
import {commitWorkspace} from '../lib/chat-state.ts';
import {readOperation} from '../lib/workspace-storage.ts';
import {parseConversation} from '../lib/conversation-response.ts';
import {database} from './database.mjs';
const date=addDays(localDay(),1),now=localDay()+'T08:00';
const task=(id,more={})=>({type:'task.save',data:{id,name:id,projectId:'p',start:localDay(),end:addDays(date,10),hours:2,...more}});
const follow=(id,more={})=>({type:'followup.save',data:{id,name:'等待'+id,taskId:'t',dueAt:date+'T10:00',blocksTask:true,...more}});
const seed=(ops=[])=>applyOperations(emptyData(),[{type:'project.save',data:{id:'p',name:'宣传片',start:localDay(),end:addDays(date,10)}},task('t'),...ops],'seed');
const planInput={date,start:'14:00',end:'17:00',minutes:120,energy:'focus'};
const tool=(responses)=>({tool_calls:[{function:{name:'respond_to_user',arguments:JSON.stringify({responses})}}]});

test('模糊想法独立保存、旧备份兼容，不虚构项目或日历',()=>{
 const data=applyOperations(emptyData(),[{type:'capture.save',data:{id:'c',name:'想学剪辑',notes:'等忙完了再考虑，没定时间'}}],'capture');
 assert.equal(data.captures[0].status,'inbox');assert.equal(data.projects.length+data.tasks.length+data.blocks.length,0);
 const legacy={...emptyData()};delete legacy.captures;delete legacy.followups;assert.deepEqual(parseBackup({data:legacy}).captures,[]);
 assert.equal(restorePlan(emptyData(),parseBackup(exportBackup(data)),'missing','restore').data.captures[0].notes,data.captures[0].notes);
});
test('整理事项与原记录原子提交，故障回滚，重放不重复',async()=>{
 const {sql,db,snapshot,update}=database();update(seed([{type:'capture.save',data:{id:'c',name:'做片头',notes:'原话不能丢'}}]));const before=snapshot(),ops=convertCapture(before.data,before.data.captures[0],{projectId:'p',start:date,end:date,hours:1},'converted'),next=applyOperations(before.data,ops,'convert');
 sql.exec("CREATE TRIGGER fail_capture BEFORE INSERT ON workspace_records WHEN NEW.kind='captures' BEGIN SELECT RAISE(ABORT,'fault'); END");
 await assert.rejects(commitWorkspace(db,'owner',before,next,'convert','hash'),/fault/);assert.deepEqual(snapshot(),before);assert.equal(await readOperation(db,'owner','convert'),null);
 sql.exec('DROP TRIGGER fail_capture');assert.equal(await commitWorkspace(db,'owner',before,next,'convert','hash'),true);assert.equal(await commitWorkspace(db,'owner',snapshot(),next,'convert','hash'),false);
 assert.equal(snapshot().data.tasks.filter(t=>t.id==='converted').length,1);assert.equal(snapshot().data.captures[0].notes,'原话不能丢');assert.equal(snapshot().data.captures[0].taskId,'converted');sql.close();
});
test('部分资料到齐只解除对应等待，不完成任务；手动等待仍须确认',()=>{
 let d=seed([follow('名单'),follow('素材')]);assert.equal(taskBlockers(d,d.tasks[0]).length,2);
 d=applyOperations(d,completeFollowup(d.followups[0]),'partial');assert.equal(taskBlockers(d,d.tasks[0]).length,1);assert.equal(d.tasks[0].status,'todo');
 d=applyOperations(d,completeFollowup(d.followups[1]),'all');assert.equal(taskBlockers(d,d.tasks[0]).length,0);
 d=applyOperations(d,[task('t',{status:'waiting'})],'manual');assert.ok(taskBlockers(d,d.tasks[0]).length);
});
test('事项换项目后跟进与随手记同步关联；补回旧备份适配现有任务',()=>{
 const before=seed([{type:'project.save',data:{id:'p2',name:'新项目',start:localDay(),end:addDays(date,10)}},follow('f',{projectId:'p'}),{type:'capture.save',data:{id:'c',name:'原文',projectId:'p',taskId:'t'}}]);
 const moved=applyOperations(before,[task('t',{projectId:'p2'})],'move');assert.equal(moved.followups[0].projectId,'p2');assert.equal(moved.captures[0].projectId,'p2');
 const missing=applyOperations(moved,[{type:'followup.delete',id:'f'}],'remove'),restored=restorePlan(missing,parseBackup(exportBackup(before)),'missing','restore');assert.equal(restored.data.followups[0].projectId,'p2');assert.ok(restored.warnings.some(w=>w.includes('现在所属')));
 const copy=restorePlan(emptyData(),parseBackup(exportBackup(before)),'copies','copy').data;assert.equal(copy.followups[0].taskId,copy.tasks[0].id);assert.equal(copy.captures[0].taskId,copy.tasks[0].id);
});
test('删除旧项目必须发现后来新增的仅任务关联跟进；确认删除后保留跟进原文',()=>{
 const d=seed(),ops=[{type:'project.delete',id:'p'}],base=captureBaseline(d,ops),changed=applyOperations(d,[follow('f')],'new-follow');
 assert.throws(()=>mergeChanges(changed,ops,base),/新的修改/);const deleted=applyOperations(changed,ops,'delete');assert.equal(deleted.followups[0].name,'等待f');assert.equal(deleted.followups[0].taskId,'');assert.equal(deleted.followups[0].blocksTask,false);
});
test('两小时投入避开会议并扣除已有预留，计划不挤掉固定日程',()=>{
 const d=seed([task('t',{hours:1}),task('u',{hours:3}),{type:'block.save',data:{id:'existing',taskId:'t',name:'已留半小时',start:date+'T14:30',end:date+'T15:00'}},{type:'block.save',data:{id:'fixed',name:'接孩子',start:date+'T16:00',end:date+'T16:30',fixed:true}}]);
 const before=structuredClone(d),p=makeDayPlan(d,planInput,[],'two-hours',now);assert.equal(p.plannedMinutes,120);assert.equal(p.items.filter(v=>v.taskId==='t').reduce((n,v)=>n+v.minutes,0),30);
 const all=[...d.blocks,...p.operations.map(o=>o.data)];for(const a of all)for(const b of all)if(a!==b)assert.ok(a.end<=b.start||b.end<=a.start);assert.deepEqual(d,before);
});
test('高优先事项只能晚些开始时，上午空档仍可安排轻量事项',()=>{
 const d=seed([task('t',{priority:'high',hours:1}),task('u',{priority:'low',hours:1,energy:'light'})]),memory={id:'m',kind:'constraint',certainty:'confirmed',rule:'not_before',time:'10:00',date,subjectId:'t'};
 const p=makeDayPlan(d,{...planInput,start:'09:00',end:'11:00'},[memory],'holes',now);assert.equal(p.plannedMinutes,120);assert.equal(p.items.find(v=>v.taskId==='t').start,date+'T10:00');assert.equal(p.items.find(v=>v.taskId==='u').start,date+'T09:00');
});
test('低精力不自动安排高耗能工作，容量不足保持留白，今天不倒排',()=>{
 const d=seed([task('t',{deadline:date,energy:'focus',hours:3}),task('u',{energy:'light',hours:0.5})]);const p=makeDayPlan(d,{...planInput,energy:'light'},[],'light',now);assert.equal(p.plannedMinutes,30);assert.equal(p.unfilledMinutes,90);assert.ok(p.items.every(v=>v.taskId==='u'));
 const today=makeDayPlan(d,{...planInput,date:localDay(),start:'08:00',end:'10:00'},[],'today',localDay()+'T09:07');assert.ok(today.items.every(v=>v.start>=localDay()+'T09:15'));assert.throws(()=>makeDayPlan(d,{...planInput,date:addDays(localDay(),-1)},[],'past',now),/今天或以后/);
});
test('同一段话先新增阻塞再自动挑选，不会安排尚未到齐资料的事项',()=>{
 const quote='剪片还要等素材，收到前不能做，给明天九到十一点挑两小时的事',d=seed([task('u')]);
 const r=parseConversation(tool([{kind:'change',quote,operations:[follow('f')]},{kind:'change',quote,dayPlan:{...planInput,start:'09:00',end:'11:00'}}]),d,'mixed',quote,[],[]);
 const blocks=r.draft.operations.filter(o=>o.type==='block.save');assert.ok(blocks.length);assert.ok(blocks.every(o=>o.data.taskId==='u'));
});
test('同一段话解除最后等待后可立即挑选安排',()=>{
 const quote='素材收齐了，给明天九到十一点挑两小时的事',d=seed([follow('f')]);
 const r=parseConversation(tool([{kind:'change',quote,operations:[{type:'followup.save',data:{id:'f',status:'resolved'}}]},{kind:'change',quote,dayPlan:{...planInput,start:'09:00',end:'11:00'}}]),d,'unblock',quote,[],[]);
 assert.equal(r.draft.operations.filter(o=>o.type==='block.save').length,2);
});
test('Qwen随手记由服务端保留逐字原话，避免摘要丢失不确定性',()=>{
 const quote='想学点剪辑吧，哪天有空再说，不急',r=parseConversation(tool([{kind:'change',quote,operations:[{type:'capture.save',data:{id:'c',name:'学剪辑',notes:'立刻学习'}}]}]),emptyData(),'capture',quote,[],[]);assert.equal(r.draft.operations[0].data.notes,quote);
});
test('自动计划从两小时改成一小时，替换旧时段而不叠加',()=>{
 const d=seed(),oldOps=makeDayPlan(d,{...planInput,start:'09:00',end:'11:00'},[],'old',now).operations,old={id:'old-apply',summary:'两小时',operations:oldOps,baseline:captureBaseline(d,oldOps),workRevision:d.workRevision},quote='原方案重排，明天九到十一点只有一小时';
 const message=tool([{kind:'change',quote,dayPlan:{...planInput,start:'09:00',end:'11:00',minutes:60}}]),args=JSON.parse(message.tool_calls[0].function.arguments);args.planUpdates=[{id:'old-apply',action:'supersede',quote}];message.tool_calls[0].function.arguments=JSON.stringify(args);
 const r=parseConversation(message,d,'new',quote,[old],[]);assert.equal(r.draft.operations.length,1);assert.equal(r.draft.operations[0].data.id,'new-slot-0');
});
test('系统日历导出含时区转换、稳定标识、提醒，长中文按字节折行',()=>{
 const d=seed([follow('f',{name:'素材，名单;核对',notes:'中文'.repeat(100)+'\n下一步'})]),ics=followupCalendar(d,d.followups),unfolded=ics.replace(/\r\n /g,'');
 assert.match(unfolded,/UID:f@time-master/);assert.ok(unfolded.includes('DTSTART:'+date.replaceAll('-','')+'T020000Z'));assert.match(unfolded,/TRIGGER:-PT10M/);assert.ok(unfolded.includes('素材\\，')===false);assert.ok(unfolded.includes('名单\\;核对'));assert.ok(ics.split('\r\n').every(line=>Buffer.byteLength(line)<=74));assert.equal((followupCalendar(d,[{...d.followups[0],status:'resolved'}]).match(/BEGIN:VEVENT/g)||[]).length,0);
});
