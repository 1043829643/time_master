import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyData,applyOperations,addDays,localDay} from '../lib/domain.ts';
import {makeDayPlan,convertCapture,convertCaptureToProject,convertCaptureWithNewProject,completeFollowup} from '../lib/daily-planning.ts';
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
test('随手记可直接整理为项目，原话和关联一并保留',()=>{
 const original='我要完成时间管理大师的开发，但范围还没有想清楚',before=applyOperations(emptyData(),[{type:'capture.save',data:{id:'c-project',name:'时间管理大师开发',notes:original}}],'capture-project');
 const ops=convertCaptureToProject(before.captures[0],{name:'时间管理大师',goal:original,start:localDay(),end:addDays(localDay(),30)},'new-project');
 const after=applyOperations(before,ops,'project-from-capture');
 assert.equal(after.projects.length,1);assert.equal(after.tasks.length,0);assert.equal(after.projects[0].goal,original);
 assert.equal(after.captures[0].notes,original);assert.equal(after.captures[0].projectId,'new-project');assert.equal(after.captures[0].status,'converted');assert.equal(after.captures[0].conversionKind,'project');
 assert.throws(()=>applyOperations(after,[{type:'capture.save',data:{...after.captures[0],status:'archived'}}],'hide-project-link'),/仍关联已有项目/);
});
test('建新项目并整理成事项在同一批操作内成立；重复整理已关联记录会被拦住',()=>{
 const original='做一个时间管理网站，先把项目全景完成',before=applyOperations(emptyData(),[{type:'capture.save',data:{id:'c-task',name:'时间管理网站',notes:original}}],'capture-task');
 const input={projectName:'时间管理大师',taskName:'做项目全景',start:localDay(),end:addDays(localDay(),30),hours:12};
 const ops=convertCaptureWithNewProject(before.captures[0],input,'new-task','new-project'),after=applyOperations(before,ops,'project-and-task');
 assert.deepEqual(ops.map(op=>op.type),['project.save','task.save','capture.save']);
 assert.equal(after.projects.length,1);assert.equal(after.tasks.length,1);assert.equal(after.tasks[0].projectId,'new-project');assert.equal(after.tasks[0].name,input.taskName);assert.equal(after.tasks[0].description,original);
 assert.equal(after.captures[0].notes,original);assert.equal(after.captures[0].taskId,'new-task');assert.equal(after.captures[0].projectId,'new-project');assert.equal(after.captures[0].conversionKind,'task');
 assert.throws(()=>convertCaptureToProject(after.captures[0],{name:'重复',goal:'',start:input.start,end:input.end},'duplicate-project'),/已关联/);
 assert.throws(()=>applyOperations(after,[{type:'capture.save',data:{...after.captures[0],status:'inbox'}}],'reopen-linked'),/已有对应/);
 const reopened={...after.captures[0],status:'inbox'};
 assert.throws(()=>convertCapture(after,reopened,{projectId:'new-project',start:input.start,end:input.end,hours:1},'duplicate-task'),/已关联/);
 assert.throws(()=>convertCaptureWithNewProject(reopened,input,'duplicate-task','duplicate-project'),/已关联/);
});
test('同时新建项目与事项的整理失败时三条记录一起回滚',async()=>{
 const {sql,db,snapshot,update}=database();update(applyOperations(emptyData(),[{type:'capture.save',data:{id:'c-atomic',name:'开发网站',notes:'原话必须留住'}}],'seed-capture'));
 const before=snapshot(),ops=convertCaptureWithNewProject(before.data.captures[0],{projectName:'时间管理大师',taskName:'实现全景',start:localDay(),end:addDays(localDay(),14),hours:8},'atomic-task','atomic-project'),after=applyOperations(before.data,ops,'atomic-convert');
 sql.exec("CREATE TRIGGER fail_new_capture BEFORE INSERT ON workspace_records WHEN NEW.kind='captures' BEGIN SELECT RAISE(ABORT,'fault'); END");
 await assert.rejects(commitWorkspace(db,'owner',before,after,'atomic-convert','hash'),/fault/);
 assert.deepEqual(snapshot(),before);assert.equal(await readOperation(db,'owner','atomic-convert'),null);sql.close();
});
test('删除整理目标后原随手记回到待整理，并保留仍存在的项目上下文',()=>{
 const original=applyOperations(emptyData(),[{type:'capture.save',data:{id:'c',name:'开发网站',notes:'原话仍要保留'}}],'original');
 const taskData=applyOperations(original,convertCaptureWithNewProject(original.captures[0],{projectName:'网站',taskName:'设计首页',start:localDay(),end:date,hours:2},'t','p'),'convert-task');
 const afterTaskDelete=applyOperations(taskData,[{type:'task.delete',id:'t'}],'delete-task');
 assert.equal(afterTaskDelete.captures[0].status,'inbox');assert.equal(afterTaskDelete.captures[0].taskId,'');assert.equal(afterTaskDelete.captures[0].projectId,'p');assert.equal(afterTaskDelete.captures[0].conversionKind,'');assert.equal(afterTaskDelete.captures[0].notes,'原话仍要保留');
 assert.equal(convertCapture(afterTaskDelete,afterTaskDelete.captures[0],{projectId:'p',start:localDay(),end:date,hours:1},'replacement')[0].type,'task.save');
 const followData=applyOperations(afterTaskDelete,[{type:'followup.save',data:{id:'f',name:'联系设计师',projectId:'p'}},{type:'capture.save',data:{...afterTaskDelete.captures[0],status:'converted',followupId:'f'}}],'convert-followup');
 const afterFollowupDelete=applyOperations(followData,[{type:'followup.delete',id:'f'}],'delete-followup');
 assert.equal(afterFollowupDelete.captures[0].status,'inbox');assert.equal(afterFollowupDelete.captures[0].followupId,'');assert.equal(afterFollowupDelete.captures[0].projectId,'p');
 assert.equal(afterFollowupDelete.captures[0].conversionKind,'');
 const afterProjectDelete=applyOperations(afterFollowupDelete,[{type:'project.delete',id:'p'}],'delete-project');
 assert.equal(afterProjectDelete.captures[0].status,'inbox');assert.equal(afterProjectDelete.captures[0].projectId,'');
 const projectCapture=applyOperations(original,convertCaptureToProject(original.captures[0],{name:'网站',goal:'开发网站',start:localDay(),end:date},'project-only'),'convert-project');
 assert.equal(applyOperations(projectCapture,[{type:'project.delete',id:'project-only'}],'remove-project').captures[0].status,'inbox');
});
test('仅将随手记归属现有项目后仍能归档和恢复',()=>{
 const base=seed([{type:'capture.save',data:{id:'context',name:'想一想首页',projectId:'p'}}]);
 const archived=applyOperations(base,[{type:'capture.save',data:{...base.captures[0],status:'archived'}}],'archive-context');
 const reopened=applyOperations(archived,[{type:'capture.save',data:{...archived.captures[0],status:'inbox'}}],'reopen-context');
 assert.equal(reopened.captures[0].projectId,'p');assert.equal(reopened.captures[0].conversionKind,'');assert.equal(reopened.captures[0].status,'inbox');
});
test('部分资料到齐只解除对应等待，不完成任务；手动等待仍须确认',()=>{
 let d=seed([follow('名单'),follow('素材')]);assert.equal(taskBlockers(d,d.tasks[0]).length,2);
 d=applyOperations(d,completeFollowup(d.followups[0]),'partial');assert.equal(taskBlockers(d,d.tasks[0]).length,1);assert.equal(d.tasks[0].status,'todo');
 d=applyOperations(d,completeFollowup(d.followups[1]),'all');assert.equal(taskBlockers(d,d.tasks[0]).length,0);
 d=applyOperations(d,[task('t',{status:'waiting'})],'manual');assert.ok(taskBlockers(d,d.tasks[0]).length);
});
test('事项换项目后跟进与随手记同步关联；补回旧备份适配现有任务',()=>{
 const before=seed([{type:'project.save',data:{id:'p2',name:'新项目',start:localDay(),end:addDays(date,10)}},follow('f',{projectId:'p'}),{type:'capture.save',data:{id:'c',name:'原文',projectId:'p',taskId:'t',status:'converted'}}]);
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
