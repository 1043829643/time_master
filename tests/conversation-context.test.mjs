import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyData} from '../lib/domain.ts';
import {CHAT_CONTEXT_LIMIT,CHAT_REVIEW_RESERVE,conversationWorkspace,assertVisibleOperations,recentConversation,recentUnfinished,relevantUnfinished,reviewCandidate,assertConversationPromptBudget,assertPendingConfirmationCoverage,assertReadOnlyTurn,ContextTooLargeError} from '../lib/conversation-context.ts';

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

test('明确日期的只读日程包含当天全部交叠时间，日常工作查询只取可推进候选',()=>{
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
 const daily=conversationWorkspace(data,'明天可做什么？',3000,'2026-10-03');
 assert.deepEqual(daily.context.blocks.map(b=>b.id),['overnight','meeting']);
 assert.deepEqual(daily.context.tasks.map(t=>t.id),['meeting-task']);
 assert.match(daily.context.coverage.note,/可推进/);
});

test('含糊续话只沿用最近用户明确点名的唯一记录，旧助手话语和多个目标不能决定修改',()=>{
 const data=emptyData();data.projects=[project('p1','灵感收集器','A'.repeat(6000)),project('p2','时间伙伴','B'.repeat(6000))];
 data.tasks=[task('t1','p1','交互原型'),task('t2','p2','语音测试')];
 const history=[{id:'u1',role:'user',content:'看看交互原型现在做到哪了',at:''},{id:'a1',role:'assistant',content:'时间伙伴也可以处理',at:''}];
 const read=conversationWorkspace(data,'那周一下午呢？',8000,'2026-10-03',{messages:history});
 assert.deepEqual(read.context.tasks.map(t=>t.id),['t1']);
 assert.deepEqual(read.context.projects.map(p=>p.id),['p1']);
 assert.throws(()=>assertVisibleOperations(data,[{type:'task.save',data:{id:'t1',status:'doing'}}],read.visible,read.editable),ContextTooLargeError);
 const change=conversationWorkspace(data,'把它挪到周一下午',8000,'2026-10-03',{messages:history});
 assert.doesNotThrow(()=>assertVisibleOperations(data,[{type:'task.save',data:{id:'t1',status:'doing'}}],change.visible,change.editable));
 const onlyRead=conversationWorkspace(data,'先别改，只看看那个',8000,'2026-10-03',{messages:history});
 assert.equal(onlyRead.readOnly,true);
 assert.throws(()=>assertVisibleOperations(data,[{type:'task.save',data:{id:'t1',status:'doing'}}],onlyRead.visible,onlyRead.editable),ContextTooLargeError);
 const ambiguous=[{id:'u2',role:'user',content:'看看交互原型和语音测试',at:''}];
 assert.throws(()=>conversationWorkspace(data,'那个周一下午呢？',8000,'2026-10-03',{messages:ambiguous}),ContextTooLargeError);
});

test('只用当前仍待确认的唯一方案续接确认，不把旧方案历史当目标',()=>{
 const data=emptyData();data.projects=[project('p1','灵感收集器','A'.repeat(6000)),project('p2','时间伙伴','B'.repeat(6000))];data.tasks=[task('t1','p1','交互原型')];
 const pending=[{id:'plan-1',operations:[{type:'task.save',data:{id:'t1',status:'doing'}}]}];
 const selected=conversationWorkspace(data,'就这样',8000,'2026-10-03',{pending});
 assert.deepEqual(selected.context.tasks.map(t=>t.id),['t1']);
 assert.throws(()=>assertVisibleOperations(data,[{type:'task.save',data:{id:'t1',status:'doing'}}],selected.visible,selected.editable),ContextTooLargeError);
 assert.throws(()=>conversationWorkspace(data,'就这样',8000,'2026-10-03',{pending:[...pending,{id:'plan-2',operations:[]}]}),ContextTooLargeError);
 const full=emptyData();full.projects=[project('p','小项目')];
 assert.equal(conversationWorkspace(full,'确认',10000,'2026-10-03').context.coverage.mode,'complete');
 assert.throws(()=>assertPendingConfirmationCoverage('confirm',1),ContextTooLargeError);
 assert.doesNotThrow(()=>assertPendingConfirmationCoverage('reply',1));
});

test('失败请求只在明确续接紧邻失败轮次时回灌，普通聊天和旧失败不带入',()=>{
 const failed={request_id:'failed',request_text:'替我改项目',state:'failed'};
 const completed={request_id:'done',request_text:'谢谢',state:'completed'};
 assert.deepEqual(relevantUnfinished([failed],'current','今天有点累').included,[]);
 assert.deepEqual(relevantUnfinished([failed],'current','继续刚才那条').included.map(v=>v.request_id),['failed']);
 assert.deepEqual(relevantUnfinished([failed,completed],'current','继续刚才那条').included,[]);
 assert.deepEqual(relevantUnfinished([failed],'current','我们继续聊聊').included,[]);
});

test('先查看再明确安排可执行；纯讨论与情绪聊天不能凭空生成记录',()=>{
 const data=emptyData();data.projects=[project('p1','灵感收集器','A'.repeat(6000)),project('p2','时间伙伴','B'.repeat(6000))];
 const mixed=conversationWorkspace(data,'先看下周一空不空，再帮我安排14-15点会议',8000,'2026-10-03');
 assert.equal(mixed.readOnly,false);
 assert.equal(conversationWorkspace(data,'先别安排灵感收集器，另外帮我新建会议项目',8000,'2026-10-03').readOnly,false);
 assert.equal(conversationWorkspace(data,'没想好，先记着',8000,'2026-10-03').readOnly,false);
 const suggestion=conversationWorkspace(data,'先看看灵感收集器怎么安排',8000,'2026-10-03');
 assert.equal(suggestion.readOnly,true);
 assert.throws(()=>assertReadOnlyTurn(suggestion.readOnly,[{type:'task.save',data:{id:'new',name:'临时事项'}}],[],'execute'),/不能修改/);
 const proposal=conversationWorkspace(data,'先帮我看个方案：10月9日留一段独立日程，先别应用',8000,'2026-10-03');
 assert.equal(proposal.readOnly,false);
 assert.doesNotThrow(()=>assertReadOnlyTurn(proposal.readOnly,[{type:'block.save',data:{id:'new',name:'临时日程'}}],[],'preview'));
 assert.equal(conversationWorkspace(data,'别应用，先放着',8000,'2026-10-03').readOnly,true);
 const chat=conversationWorkspace(data,'我有点累，先聊聊',8000,'2026-10-03');
 assert.equal(chat.readOnly,true);
 assert.deepEqual(chat.context.projects,[]);
 assert.throws(()=>assertReadOnlyTurn(chat.readOnly,[{type:'capture.save',data:{id:'new',name:'莫须有'}}],[],'execute'),/不能修改/);
 assert.throws(()=>conversationWorkspace(data,'我有点累，说说所有项目进度',8000,'2026-10-03'),ContextTooLargeError);
});

test('中文月日与完整年月日可查日程，跨年不明时先问年份',()=>{
 const data=emptyData();data.projects=[project('p','Unrelated','X'.repeat(8000))];
 data.blocks=[block('oct','十月会议','2026-10-05T10:00','2026-10-05T11:00'),block('jan','新年会议','2027-01-05T10:00','2027-01-05T11:00')];
 assert.deepEqual(conversationWorkspace(data,'10月5日有什么日程？',3000,'2026-10-03').context.blocks.map(b=>b.id),['oct']);
 assert.deepEqual(conversationWorkspace(data,'2027年1月5日有哪些安排？',3000,'2026-10-03').context.blocks.map(b=>b.id),['jan']);
 assert.deepEqual(conversationWorkspace(data,'明年1月5日有哪些安排？',3000,'2026-10-03').context.blocks.map(b=>b.id),['jan']);
 assert.throws(()=>conversationWorkspace(data,'1月5日有什么日程？',3000,'2026-10-03'),/补充年份/);
});

test('两个相对日期的查询带入两天日程，改口后只带入最终日期',()=>{
 const data=emptyData();data.projects=[project('p','Unrelated','X'.repeat(8000))];
 data.blocks=[block('tomorrow','明天会议','2026-10-04T10:00','2026-10-04T11:00'),block('later','后天会议','2026-10-05T10:00','2026-10-05T11:00')];
 assert.deepEqual(conversationWorkspace(data,'明天和后天有哪些日程？',3000,'2026-10-03').context.blocks.map(b=>b.id),['tomorrow','later']);
 assert.deepEqual(conversationWorkspace(data,'明天或后天哪天有空？',3000,'2026-10-03').context.blocks.map(b=>b.id),['tomorrow','later']);
 data.blocks=[];
 assert.deepEqual(conversationWorkspace(data,'明天或后天哪天有空？',3000,'2026-10-03').context.blocks,[]);
 data.blocks=[block('tomorrow','明天会议','2026-10-04T10:00','2026-10-04T11:00'),block('later','后天会议','2026-10-05T10:00','2026-10-05T11:00')];
 assert.deepEqual(conversationWorkspace(data,'明天，不对，后天有哪些日程？',3000,'2026-10-03').context.blocks.map(b=>b.id),['later']);
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
