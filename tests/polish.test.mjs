import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyData,applyOperations} from '../lib/domain.ts';
import {proposalConflicts,dayCandidates,timelineCell,taskPosition} from '../lib/planning.ts';
import {speechChunks} from '../lib/speech.ts';
import {parseAssistantResponse} from '../lib/assistant-response.ts';
const block=(id,start,end,extra={})=>({type:'block.save',data:{id,name:id,start:'2026-09-16T'+start,end:'2026-09-16T'+end,...extra}});
test('整批新日程内部冲突，并且预览不会修改操作',()=>{
 const ops=[block('a','10:00','11:00'),block('b','10:30','11:30')],original=structuredClone(ops);
 assert.equal(proposalConflicts(emptyData(),ops).length,1);assert.deepEqual(ops,original);
});
test('先挪走再占用、删除、完成、相邻时间不误报',()=>{
 const data=applyOperations(emptyData(),[block('a','10:00','11:00')],'seed');
 assert.equal(proposalConflicts(data,[block('a','12:00','13:00'),block('b','10:00','11:00')]).length,0);
 assert.equal(proposalConflicts(data,[block('b','10:30','11:30'),{type:'block.delete',id:'a'}]).length,0);
 assert.equal(proposalConflicts(data,[block('b','11:00','12:00')]).length,0);
 assert.equal(proposalConflicts(data,[block('b','10:30','11:30',{done:true})]).length,0);
 assert.equal(proposalConflicts(data,[block('b','10:30','11:30'),block('b','13:00','14:00')]).length,0);
});
test('不重复报告未改动的旧冲突，恢复完成状态时仍检查',()=>{
 const data=applyOperations(emptyData(),[block('a','10:00','11:00'),block('b','10:30','11:30')],'seed');
 assert.equal(proposalConflicts(data,[{type:'block.save',data:{id:'a',name:'改名'}}]).length,0);
 data.blocks[0].done=true;assert.equal(proposalConflicts(data,[{type:'block.save',data:{id:'a',done:false}}]).length,1);
});
test('全年单日条宽为正，相邻事项不重叠且真实比例不变',()=>{
 const cell=timelineCell(900,368),a=taskPosition('2026-01-01',{start:'2026-09-15',end:'2026-09-15'},cell),b=taskPosition('2026-01-01',{start:'2026-09-16',end:'2026-09-16'},cell);
 assert.ok(a.width>=100);assert.ok(a.left+a.width<b.left);assert.equal(b.left-a.left,cell);
 assert.equal(taskPosition('2026-01-01',{start:'2026-09-15',end:'2026-09-16'},cell).width,cell*2-6);
});
test('候选包含第13件，并区分前置未完、等待、暂停和跨项目依赖',()=>{
 const ops=[{type:'project.save',data:{id:'p',name:'项目',start:'2026-09-01',end:'2026-10-01'}}];
 for(let i=0;i<16;i++)ops.push({type:'task.save',data:{id:'t'+i,projectId:'p',name:'事项'+i,start:'2026-09-01',end:'2026-10-01'}});
 let data=applyOperations(emptyData(),ops,'seed');data.tasks[14].dependencies=['t0'];data.tasks[15].status='waiting';
 assert.equal(dayCandidates(data,'2026-09-16').ready.length,14);assert.equal(dayCandidates(data,'2026-09-16').blocked.length,2);
 data.tasks[0].status='done';assert.ok(dayCandidates(data,'2026-09-16').ready.some(t=>t.id==='t14'));
 data.projects[0].status='paused';assert.equal(dayCandidates(data,'2026-09-16').ready.length,0);
});
test('长语音分段保留全部文字和末尾，emoji不被拆开',()=>{
 const input=('今天先完成需求整理。再安排沟通！😀').repeat(100)+'最后记得休息。',chunks=speechChunks(input);
 assert.ok(chunks.length>1);assert.equal(chunks.join(''),input);assert.ok(chunks.every(c=>c.length<=540&&!/[\uD800-\uDBFF]$/.test(c)));assert.ok(chunks.at(-1).endsWith('最后记得休息。'));
});
test('纯文本假方案不会当作成功回复；闲聊和真实方案分开处理',()=>{
 const tool=(name,args)=>({tool_calls:[{function:{name,arguments:JSON.stringify(args)}}]});
 assert.throws(()=>parseAssistantResponse({content:'请检查下方变更'},emptyData(),'req'));
 assert.throws(()=>parseAssistantResponse(tool('reply_to_user',{reply:'请检查下方变更'}),emptyData(),'req'));
 assert.equal(parseAssistantResponse(tool('reply_to_user',{reply:'你想安排在哪一天？'}),emptyData(),'req').draft,null);
 const parsed=parseAssistantResponse(tool('propose_changes',{summary:'安排测试',operations:[block('a','10:00','11:00')]}),emptyData(),'req');assert.equal(parsed.draft.operations.length,1);
});
