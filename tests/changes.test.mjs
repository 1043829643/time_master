import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyData,applyOperations} from '../lib/domain.ts';
import {captureBaseline,mergeChanges,ChangeConflict} from '../lib/changes.ts';
import {changeWarnings,blockRisks,releasableBlocks} from '../lib/planning.ts';
import {parseAssistantResponse} from '../lib/assistant-response.ts';
import {draftKey} from '../lib/editor-draft.ts';
const apply=(data,ops)=>applyOperations(data,ops,crypto.randomUUID());
const project=(id)=>({type:'project.save',data:{id,name:id,start:'2026-09-01',end:'2026-09-30'}});
const task=(id,extra={})=>({type:'task.save',data:{id,projectId:'p',name:id,start:'2026-09-16',end:'2026-09-20',...extra}});
const block=(id,extra={})=>({type:'block.save',data:{id,name:id,start:'2026-09-18T10:00',end:'2026-09-18T11:00',...extra}});
const seed=()=>apply(emptyData(),[project('p'),project('q'),task('a'),task('b')]);
test('无关项目更新不使编辑失效，同一事项不同字段合并且不回滚新值',()=>{
 const base=seed(),ops=[{type:'task.save',data:{...base.tasks[0],result:'我的成果'}}],origin=captureBaseline(base,ops),current=apply(base,[{type:'project.save',data:{id:'q',goal:'他处更新'}},{type:'task.save',data:{id:'a',name:'新名称'}}]);
 const next=apply(current,mergeChanges(current,ops,origin));assert.equal(next.tasks[0].result,'我的成果');assert.equal(next.tasks[0].name,'新名称');assert.equal(next.projects[1].goal,'他处更新');
});
test('同字段相异内容必须选择，同值合并成功，服务端时间戳不触发冲突',()=>{
 const base=seed(),ops=[task('a',{result:'我的版本'})],origin=captureBaseline(base,ops),current=apply(base,[task('a',{result:'其他版本'})]);
 assert.throws(()=>mergeChanges(current,ops,origin),e=>e instanceof ChangeConflict&&e.conflicts.some(c=>c.field==='result'&&c.current==='其他版本'));
 assert.equal(mergeChanges(current,ops,origin,'mine')[0].data.result,'我的版本');assert.equal(mergeChanges(current,ops,origin,'theirs')[0].data.result,'其他版本');
 assert.equal(mergeChanges(apply(base,ops),ops,origin)[0].data.result,'我的版本');
});
test('删除记录后旧编辑不能复活，新建编号冲突不能覆盖',()=>{
 const base=seed(),ops=[task('a',{name:'改名'})],origin=captureBaseline(base,ops),removed=apply(base,[{type:'task.delete',id:'a'}]);assert.throws(()=>mergeChanges(removed,ops,origin),ChangeConflict);
 const fresh=[task('new')],freshBase=captureBaseline(base,fresh),current=apply(base,[task('new',{name:'其他人创建'})]);assert.throws(()=>mergeChanges(current,fresh,freshBase),ChangeConflict);
});
test('旧删除方案不能顺带删除后来新增的子事项或工程',()=>{
 const base=seed(),ops=[{type:'project.delete',id:'p'}],origin=captureBaseline(base,ops);
 for(const extra of [task('new'),{type:'resource.save',data:{id:'r',projectId:'p',name:'新工程',path:'D:/new'}}])assert.throws(()=>mergeChanges(apply(base,[extra]),ops,origin),ChangeConflict);
});
test('删除事项或联系人时保护后来新增的反向引用',()=>{
 let base=seed(),ops=[{type:'task.delete',id:'a'}],origin=captureBaseline(base,ops);
 assert.throws(()=>mergeChanges(apply(base,[task('b',{dependencies:['a']})]),ops,origin),ChangeConflict);
 assert.throws(()=>mergeChanges(apply(base,[block('new',{taskId:'a'})]),ops,origin),ChangeConflict);
 base=apply(base,[{type:'contact.save',data:{id:'c',name:'联系人'}}]);ops=[{type:'contact.delete',id:'c'}];origin=captureBaseline(base,ops);
 assert.throws(()=>mergeChanges(apply(base,[task('b',{contactId:'c'})]),ops,origin),ChangeConflict);
});
test('三方合并仍整体校验日期与依赖图，失败不改变原始数据',()=>{
 const base=seed(),ops=[task('a',{end:'2026-09-17'})],origin=captureBaseline(base,ops),current=apply(base,[task('a',{start:'2026-09-19'})]);assert.throws(()=>mergeChanges(current,ops,origin),/结束日期/);assert.equal(current.tasks[0].end,'2026-09-20');
 const deps=[task('a',{dependencies:['b']})],withDep=apply(base,[task('b',{dependencies:['a']})]);assert.throws(()=>mergeChanges(withDep,deps,captureBaseline(base,deps)),/循环/);
});
test('两个独立事项的自动项目日期扩展互不覆盖',()=>{
 const base=seed(),ops=[task('a',{end:'2026-10-01'})],origin=captureBaseline(base,ops),current=apply(base,[task('b',{end:'2026-11-01'})]);const next=apply(current,mergeChanges(current,ops,origin));assert.equal(next.projects[0].end,'2026-11-01');assert.equal(next.tasks[0].end,'2026-10-01');
});
test('两份独立安排可顺序合并，新加入固定会议后重算冲突',()=>{
 const base=seed(),one=[block('one')],two=[block('two',{start:'2026-09-19T10:00',end:'2026-09-19T11:00'})];let current=apply(base,one);assert.equal(mergeChanges(current,two,captureBaseline(base,two)).length,1);
 current=apply(current,[block('meeting',{fixed:true,start:'2026-09-19T10:30',end:'2026-09-19T11:30'})]);assert.equal(changeWarnings(current,mergeChanges(current,two,captureBaseline(base,two))).filter(w=>w.code==='overlap').length,1);
});
test('改动固定安排独立警告，前置延期与完成时提示受影响日程',()=>{
 let data=apply(seed(),[block('fixed',{fixed:true}),block('work',{taskId:'b',start:'2026-09-19T15:00',end:'2026-09-19T16:00'}),task('b',{dependencies:['a']})]);
 assert.ok(changeWarnings(data,[block('fixed',{start:'2026-09-18T12:00',end:'2026-09-18T13:00',fixed:true})]).some(w=>w.code==='fixed'));
 assert.ok(changeWarnings(data,[task('a',{end:'2026-09-25'})]).some(w=>w.message.includes('2026-09-25')));
 data=apply(data,[task('b',{status:'done'})]);assert.ok(blockRisks(data,data.blocks.find(b=>b.id==='work')).some(s=>s.includes('已完成')));assert.ok(releasableBlocks(data).some(b=>b.id==='work'));
});
test('冲突摘要来自程序校验，忽略模型自相矛盾的无冲突声明',()=>{
 const data=apply(seed(),[block('meeting')]),operations=[block('work')],message={tool_calls:[{function:{name:'propose_changes',arguments:JSON.stringify({summary:'完全无冲突，可以放心安排',operations})}}]};
 const result=parseAssistantResponse(message,data,'request');assert.doesNotMatch(result.reply,/完全无冲突/);assert.match(result.reply,/时间重叠/);assert.equal(result.draft.operations.length,1);
});
test('新建草稿按日期、项目、列状态隔离，编辑草稿不依赖当前视图日期',()=>{
 assert.notEqual(draftKey({kind:'block',date:'2026-09-18'}),draftKey({kind:'block',date:'2026-09-19'}));assert.notEqual(draftKey({kind:'task',projectId:'p',status:'waiting'}),draftKey({kind:'task',projectId:'q',status:'waiting'}));assert.equal(draftKey({kind:'task',id:'a',date:'2026-09-18'}),draftKey({kind:'task',id:'a',date:'2026-09-19'}));
});
test('双重编号不一致和先删除再重建不能改写合并语义',()=>{
 const base=seed(),wrong=[{type:'project.save',id:'p',data:{...base.projects[1],name:'错误目标'}}];assert.throws(()=>apply(base,wrong));assert.throws(()=>mergeChanges(base,wrong,captureBaseline(base,wrong)));
 const mixed=[{type:'task.delete',id:'a'},task('a')];assert.throws(()=>apply(base,mixed),/同一批次/);assert.throws(()=>mergeChanges(base,mixed,captureBaseline(base,mixed)),/同一批次/);
});
test('先采用逐字段选择再验证，合法远端日期不会被我的无效组合阻塞',()=>{
 const base=seed(),ops=[task('a',{start:'2026-09-19'})],current=apply(base,[task('a',{start:'2026-09-17',end:'2026-09-18'})]);const merged=mergeChanges(current,ops,captureBaseline(base,ops),{start:'theirs'});assert.equal(merged[0].data.start,'2026-09-17');assert.equal(merged[0].data.end,'2026-09-18');
});
test('含级联删除的批次不折叠跨删除的重复迁移，合法一次迁移保留日程',()=>{
 const base=apply(seed(),[block('linked',{taskId:'a'})]);
 const unsafe=[task('a',{projectId:'q'}),{type:'project.delete',id:'p'},task('a',{projectId:'q',name:'已迁移'})];
 assert.throws(()=>mergeChanges(base,unsafe,captureBaseline(base,unsafe)),/含删除/);
 const safe=[task('a',{projectId:'q',name:'已迁移'}),{type:'project.delete',id:'p'}],next=apply(base,mergeChanges(base,safe,captureBaseline(base,safe)));assert.equal(next.blocks[0].id,'linked');assert.equal(next.tasks[0].projectId,'q');
});
test('非日程草稿不随日程选中日期变化或跨日丢失入口',()=>{
 for(const kind of ['project','task','contact','resource'])assert.equal(draftKey({kind,date:'2026-09-16'}),draftKey({kind,date:'2026-09-17'}));
});
test('部分改期方案的摘要取用已有另一端时间，不因缺省字段失败',()=>{
 const data=seed(),message={tool_calls:[{function:{name:'propose_changes',arguments:JSON.stringify({summary:'改期',operations:[task('a',{start:'2026-09-18',end:undefined})]})}}]};
 const result=parseAssistantResponse(message,data,'partial');assert.match(result.reply,/2026-09-18 → 2026-09-20/);
});
