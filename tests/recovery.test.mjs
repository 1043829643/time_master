import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyData,applyOperations} from '../lib/domain.ts';
import {blockRisks,changeWarnings} from '../lib/planning.ts';
import {pendingPlanWarnings,proposalReferences,pendingContext} from '../lib/proposal-review.ts';
import {chatAttemptFor} from '../lib/chat-input.ts';
import {mergeMessages} from '../lib/chat-history.ts';
import {parseBackup,exportBackup,restorePlan} from '../lib/backup.ts';
import {draftAsNew,draftKey,writeDraft,listDrafts,recordEntries} from '../lib/editor-draft.ts';
import {captureBaseline,mergeChanges} from '../lib/changes.ts';
const project=(id='p',name=id)=>({type:'project.save',data:{id,name,start:'2026-09-01',end:'2026-09-30'}});
const task=(id='t',extra={})=>({type:'task.save',data:{id,projectId:'p',name:id,start:'2026-09-10',end:'2026-09-20',...extra}});
const block=(id='b',start='10:00',end='11:00',extra={})=>({type:'block.save',data:{id,name:id,start:'2026-09-16T'+start,end:'2026-09-16T'+end,...extra}});
const seed=()=>applyOperations(emptyData(),[project(),task(),block('fixed','10:00','11:00',{taskId:'t',fixed:true}),block('normal','12:00','13:00',{taskId:'t'})],'seed');
const plan=(data,id,ops)=>({id,summary:id,operations:ops,workRevision:data.workRevision,baseline:captureBaseline(data,ops)});

test('事项自身推迟会提醒既有日程，缩短结束也会提醒；午夜边界不误报',()=>{
 const data=seed();assert.ok(changeWarnings(data,[task('t',{start:'2026-09-18'})]).some(w=>/早于事项预计开始/.test(w.message)));
 assert.ok(changeWarnings(data,[task('t',{end:'2026-09-15'})]).some(w=>/超出事项预计结束/.test(w.message)));
 data.tasks[0].end='2026-09-16';const b={...data.blocks[0],end:'2026-09-17T00:00'};assert.deepEqual(blockRisks(data,b),[]);b.end='2026-09-17T00:01';assert.match(blockRisks(data,b).join(),/超出/);
});
test('删事项或项目保留固定会议与已完成日程，未固定待办清理并明确提示',()=>{
 const data=seed();data.blocks.push({...data.blocks[1],id:'finished',done:true});
 for(const op of [{type:'task.delete',id:'t'},{type:'project.delete',id:'p'}]){const result=applyOperations(data,[op],'delete');assert.deepEqual(result.blocks.map(b=>[b.id,b.taskId]),[['fixed',''],['finished','']]);assert.ok(changeWarnings(data,[op]).some(w=>w.code==='fixed-retained'&&w.message.includes('fixed')));}
 assert.ok(changeWarnings(data,[{type:'block.delete',id:'fixed'}]).some(w=>w.code==='fixed'));
});
test('相同文字网络重试复用编号，显式重新整理必须新编号',()=>{
 const first=chatAttemptFor(null,' 安排明天 ');assert.equal(chatAttemptFor(first,'安排明天'),first);assert.notEqual(chatAttemptFor(first,'安排明天',true).id,first.id);assert.notEqual(chatAttemptFor(first,'安排后天').id,first.id);
});
test('未应用的两份日程互相警告；放弃其中一份后清除警告',()=>{
 const data=emptyData(),a=plan(data,'a',[block('a')]),b=plan(data,'b',[block('b','10:30','11:30')]);const warnings=pendingPlanWarnings(data,[a,b]);assert.equal(warnings.a.length,1);assert.equal(warnings.b.length,1);assert.equal(pendingPlanWarnings(data,[a]).a.length,0);assert.equal(data.blocks.length,0);
});
test('跨方案相邻、已完成、仅改名的旧日程不误报；同日程不同改期分开提示',()=>{
 const data=seed(),a=plan(data,'a',[block('a')]);
 for(const op of [block('b','11:00','12:00'),block('b','10:30','11:30',{done:true}),{type:'block.save',data:{id:'fixed',name:'改名'}}])assert.deepEqual(pendingPlanWarnings(data,[a,plan(data,'b',[op])]).a,[]);
 const x=plan(data,'x',[block('fixed','14:00','15:00')]),y=plan(data,'y',[block('fixed','16:00','17:00')]);assert.match(pendingPlanWarnings(data,[x,y]).x[0],/同一日程/);
});
test('跨页方案全量对照，警告数量及模型上下文有界',()=>{
 const data=emptyData(),plans=Array.from({length:80},(_,i)=>plan(data,'p'+i,[block('b'+i)]));const warnings=pendingPlanWarnings(data,plans,new Set(['p0']));assert.equal(warnings.p0.length,21);assert.equal(warnings.p1.length,0);assert.match(warnings.p0.at(-1),/前 20 条/);
 const c=pendingContext(data,plans,1800);assert.equal(c.pendingProposalCount,80);assert.ok(c.omittedPendingCount>0);assert.ok(JSON.stringify(c.pendingProposals).length<1900);
});
test('多新项目与事项的详情名称来自当前方案，不混用其他方案',()=>{
 const data=emptyData(),ops=[project('p1','甲产品'),project('p2','乙产品'),task('t1',{projectId:'p1',name:'甲测试'}),task('t2',{projectId:'p2',name:'乙设计'})];const refs=proposalReferences(data,ops);assert.equal(refs.projects.get('p1'),'甲产品');assert.equal(refs.projects.get('p2'),'乙产品');assert.equal(refs.tasks.get('t2'),'乙设计');assert.equal(data.projects.length,0);
});
test('旧备份与新版导出均可读取，不支持格式及无效引用被拒绝',()=>{
 const data=seed();assert.deepEqual(parseBackup({data}),parseBackup(exportBackup(data)));assert.throws(()=>parseBackup({format:'other',data}));assert.throws(()=>parseBackup({version:2,data}));data.tasks[0].projectId='missing';assert.throws(()=>parseBackup({data}),/所属项目/);
});
test('完整副本重映射全部关系，保留当前记录及聊天历史',()=>{
 const source=seed();source.tasks.push({...source.tasks[0],id:'t2',dependencies:['t'],contactId:'c'});source.contacts=[{id:'c',name:'同事',wechat:'test',notes:'',roles:[{projectId:'p',role:'设计'}]}];source.resources=[{id:'r',projectId:'p',name:'工程',device:'PC',path:'C:/test',purpose:''}];
 const current=seed();current.messages=[{id:'m',role:'user',content:'新消息',at:'now'}];const copy=structuredClone(current),result=restorePlan(current,parseBackup({data:source}),'copies',crypto.randomUUID());
 const p=result.data.projects[1],t=result.data.tasks[1],t2=result.data.tasks[2],c=result.data.contacts[0];assert.match(p.name,/恢复副本/);assert.equal(t.projectId,p.id);assert.deepEqual(t2.dependencies,[t.id]);assert.equal(t2.contactId,c.id);assert.equal(c.roles[0].projectId,p.id);assert.equal(result.data.resources[0].projectId,p.id);assert.equal(result.data.blocks[2].taskId,t.id);assert.deepEqual(result.data.messages,current.messages);assert.deepEqual(result.data.history,current.history);assert.deepEqual(current,copy);
});
test('补缺失不覆盖既有内容；需要扩展项目日期时明确预览',()=>{
 const backup=parseBackup({data:seed()}),current=seed();current.tasks=[];current.blocks=[];current.projects[0].name='新名称';current.projects[0].start='2026-09-15';current.projects[0].end='2026-09-18';
 const result=restorePlan(current,backup,'missing',crypto.randomUUID());assert.equal(result.counts.projects,0);assert.equal(result.counts.tasks,1);assert.equal(result.data.projects[0].name,'新名称');assert.ok(result.warnings.some(w=>/新名称.*2026-09-15.*2026-09-10/.test(w)));assert.equal(restorePlan(result.data,backup,'missing',crypto.randomUUID()).total,0);
});
test('超过60条可完整预览，大量重叠保持有界，容量超限不改当前数据',()=>{
 const data=seed();data.blocks=Array.from({length:1000},(_,i)=>({...data.blocks[0],id:'b'+i}));const current=emptyData(),result=restorePlan(current,parseBackup({data}),'copies',crypto.randomUUID());assert.equal(result.total,1002);assert.equal(result.warnings.length,51);assert.match(result.warnings.at(-1),/前 50 组/);assert.deepEqual(current,emptyData());
 data.blocks=Array.from({length:2000},(_,i)=>({...data.blocks[0],id:'b'+i}));const before=structuredClone(data);assert.throws(()=>restorePlan(data,parseBackup({data}),'copies',crypto.randomUUID()));assert.deepEqual(data,before);
});
test('孤立草稿另存使用新编号和新基线，保留文本并清除失效关联',()=>{
 const data=seed(),record=data.tasks[0],draft={version:1,kind:'task',id:'t',record,entries:[...recordEntries(record),['description','尚未保存的细节'],['dependencies','gone'],['contactId','gone']],baseline:captureBaseline(data,[task()]),deletionBaseline:{records:[],deletions:{}},attempt:{id:'old',fingerprint:'old'}};
 const original=structuredClone(draft),next=draftAsNew(draft,emptyData(),'new');assert.equal(next.id,'new');assert.equal(next.record,null);assert.equal(next.attempt,undefined);assert.ok(next.entries.some(([k,v])=>k==='description'&&v==='尚未保存的细节'));assert.ok(next.entries.some(([k,v])=>k==='projectId'&&v===''));assert.ok(!next.entries.some(([k])=>k==='dependencies'));assert.deepEqual(draft,original);
 const recreated=applyOperations(emptyData(),[project()],'p');assert.equal(mergeChanges(recreated,[task('new')],next.baseline)[0].data.id,'new');
});
test('草稿统一入口只显示有效本产品草稿',t=>{
 const values=new Map(),storage={setItem:(k,v)=>values.set(k,v),getItem:k=>values.get(k),key:i=>[...values.keys()][i],get length(){return values.size}};const previous=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:storage});t.after(()=>{if(previous)Object.defineProperty(globalThis,'sessionStorage',previous);else delete globalThis.sessionStorage});
 const data=seed(),draft={version:1,kind:'task',id:'t',record:data.tasks[0],entries:[['name','未保存事项']],baseline:captureBaseline(data,[task()]),deletionBaseline:{records:[],deletions:{}}};writeDraft(draftKey({kind:'task',id:'t'}),draft);storage.setItem('unrelated','{}');storage.setItem(draftKey({kind:'task',id:'bad'}),'bad json');assert.equal(listDrafts().length,1);assert.equal(listDrafts()[0].draft.entries[0][1],'未保存事项');
});
test('聊天合并去重，同一时间问题在回答前，当前文本覆盖旧缓存',()=>{
 const m=(id,role,content)=>({id,role,content,at:'2026-09-16T00:00:00.000Z'});const result=mergeMessages([m('r-a','assistant','答'),m('r-u','user','问')],[m('r-u','user','最新问')]);assert.deepEqual(result.map(m=>m.role),['user','assistant']);assert.equal(result[0].content,'最新问');
});
