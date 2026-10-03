import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyData} from '../lib/domain.ts';
import {CHAT_CONTEXT_LIMIT,CHAT_REVIEW_RESERVE,conversationWorkspace,assertVisibleOperations,recentConversation,recentUnfinished,reviewCandidate,assertConversationPromptBudget,ContextTooLargeError} from '../lib/conversation-context.ts';

const project=(id,name,goal='')=>({id,name,goal,status:'active',start:'2026-10-01',end:'2026-10-31',color:'green'});
const task=(id,projectId,name)=>({id,projectId,name,shortName:'',description:'',start:'2026-10-01',end:'2026-10-10',status:'todo',owner:'我',hours:2,dependencies:[],contactId:'',updatedAt:'',result:''});
const block=(id,name,start,end)=>({id,name,start,end,taskId:'',fixed:false,done:false});

test('小工作空间保留完整权威数据，历史按完整消息预算保留',()=>{
 const data=emptyData();data.projects=[project('p','Alpha')];
 const selected=conversationWorkspace(data,'看看 Alpha',10000,'2026-10-03');
 assert.equal(selected.context.coverage.mode,'complete');
 assert.equal(selected.visible,null);
 assert.equal(selected.context.projects.length,1);
 const messages=[{id:'a',role:'user',content:'旧'.repeat(100),at:''},{id:'b',role:'user',content:'新',at:''}];
 assert.deepEqual(recentConversation(messages,100).map(m=>m.id),['b']);
 const failed=Array.from({length:4},(_,i)=>({request_id:'f'+i,request_text:'原话'.repeat(100),state:'failed'}));
 const limited=recentUnfinished(failed,'current',750);
 assert.deepEqual(limited.included.map(r=>r.request_id),['f2','f3']);
 assert.equal(limited.omittedCount,2);
});

test('超预算时按名称忽略大小写和空格选择项目，关联事项只供阅读',()=>{
 const data=emptyData();data.projects=[project('p1','Alpha Project','A'.repeat(5000)),project('p2','Beta Project','B'.repeat(5000))];data.tasks=[task('t1','p1','设计首页'),task('t2','p2','测试支付')];
 const selected=conversationWorkspace(data,'看看 alphaproject 进展',8000,'2026-10-03');
 assert.equal(selected.context.coverage.mode,'scoped');
 assert.deepEqual(selected.context.projects.map(p=>p.id),['p1']);
 assert.deepEqual(selected.context.tasks.map(t=>t.id),['t1']);
 assert.equal(selected.context.coverage.omitted.projects,1);
 assert.throws(()=>assertVisibleOperations(data,[{type:'task.save',data:{id:'t1',status:'done'}}],selected.visible,selected.editable),ContextTooLargeError);
 assert.throws(()=>assertVisibleOperations(data,[{type:'task.save',data:{id:'t2',status:'done'}}],selected.visible,selected.editable),ContextTooLargeError);
 assert.doesNotThrow(()=>assertVisibleOperations(data,[{type:'project.save',data:{id:'p1',status:'paused'}}],selected.visible,selected.editable));
 assert.throws(()=>assertVisibleOperations(data,[{type:'project.save',data:{id:'new',name:'Beta Project'}}],selected.visible,selected.editable),ContextTooLargeError);
 assert.throws(()=>assertVisibleOperations(data,[{type:'project.save',data:{id:'new',name:'Alpha Project'}}],selected.visible,selected.editable),ContextTooLargeError);
 const taskSelection=conversationWorkspace(data,'把设计首页移到另一个项目',8000,'2026-10-03');
 assert.throws(()=>assertVisibleOperations(data,[{type:'task.save',data:{id:'t1',projectId:'p2'}}],taskSelection.visible,taskSelection.editable),ContextTooLargeError);
});

test('明确日期的只读日程包含当天全部交叠时间，全天候选查询要求缩小范围',()=>{
 const data=emptyData();data.projects=[project('p','Unrelated','X'.repeat(8000)),project('meeting-project','会议项目')];
 data.tasks=[task('meeting-task','meeting-project','讨论方案')];
 data.contacts=[{id:'person',name:'小林',wechat:'',notes:'',roles:[]}];
 data.blocks=[block('overnight','夜间值班','2026-10-03T23:00','2026-10-04T01:00'),block('meeting','会议','2026-10-04T10:00','2026-10-04T11:00'),block('later','后续会议','2026-10-05T10:00','2026-10-05T11:00')];
 data.blocks[1].taskId='meeting-task';data.blocks[1].contactId='person';
 const selected=conversationWorkspace(data,'明天有哪些日程？',3000,'2026-10-03');
 assert.deepEqual(selected.context.blocks.map(b=>b.id),['overnight','meeting']);
 assert.deepEqual(selected.context.tasks.map(t=>t.id),['meeting-task']);
 assert.deepEqual(selected.context.contacts.map(c=>c.id),['person']);
 assert.deepEqual(selected.context.projects.map(p=>p.id),['meeting-project']);
 assert.throws(()=>conversationWorkspace(data,'明天可做什么？',3000,'2026-10-03'),ContextTooLargeError);
});

test('中文月日与完整年月日可查日程，跨年不明时先问年份',()=>{
 const data=emptyData();data.projects=[project('p','Unrelated','X'.repeat(8000))];
 data.blocks=[block('oct','十月会议','2026-10-05T10:00','2026-10-05T11:00'),block('jan','新年会议','2027-01-05T10:00','2027-01-05T11:00')];
 assert.deepEqual(conversationWorkspace(data,'10月5日有什么日程？',3000,'2026-10-03').context.blocks.map(b=>b.id),['oct']);
 assert.deepEqual(conversationWorkspace(data,'2027年1月5日有哪些安排？',3000,'2026-10-03').context.blocks.map(b=>b.id),['jan']);
 assert.deepEqual(conversationWorkspace(data,'明年1月5日有哪些安排？',3000,'2026-10-03').context.blocks.map(b=>b.id),['jan']);
 assert.throws(()=>conversationWorkspace(data,'1月5日有什么日程？',3000,'2026-10-03'),/补充年份/);
});

test('相关记录本身放不下时拒绝给模型不完整事实',()=>{
 const data=emptyData();data.projects=[project('p1','Alpha','A'.repeat(8000)),project('p2','Beta','B'.repeat(8000))];
 assert.throws(()=>conversationWorkspace(data,'看看 Alpha',4000,'2026-10-03'),ContextTooLargeError);
});

test('主请求和复核请求均按最终序列化大小限额，超长候选不直接回灌',()=>{
 const data=emptyData();data.projects=[project('p','Alpha')];
 const selected=conversationWorkspace(data,'看看 Alpha',10000,'2026-10-03');
 const messages=[{role:'system',content:'工作空间：'+JSON.stringify(selected.context)},{role:'user',content:'看看 Alpha'}];
 assert.doesNotThrow(()=>assertConversationPromptBudget(messages,CHAT_REVIEW_RESERVE));
 const candidate=reviewCandidate({operations:'x'.repeat(20000)});
 assert.match(candidate,/超过可核对长度/);
 assert.doesNotThrow(()=>assertConversationPromptBudget([...messages,{role:'system',content:candidate}]));
 assert.throws(()=>assertConversationPromptBudget([{role:'system',content:'x'.repeat(CHAT_CONTEXT_LIMIT)}]),ContextTooLargeError);
});
