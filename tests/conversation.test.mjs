import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './database.mjs';
import {emptyData,applyOperations,localDay} from '../lib/domain.ts';
import {captureBaseline} from '../lib/changes.ts';
import {parseConversation} from '../lib/conversation-response.ts';
import {memoryInputSchema,prepareMemories,readMemories,constraintViolations} from '../lib/conversation-memory.ts';
import {commitChat,readChatReceipt,commitWorkspace,allPendingPlans} from '../lib/chat-state.ts';
import {commitRestore} from '../lib/restore-state.ts';
import {relativeDate} from '../lib/conversation-dates.ts';
const block=(id='b',start='10:00',fixed=false)=>({type:'block.save',data:{id,name:'工作'+id,taskId:'',start:'2026-09-17T'+start,end:'2026-09-17T11:00',fixed,done:false}});
const tool=(responses,more={})=>({tool_calls:[{function:{name:'respond_to_user',arguments:JSON.stringify({responses,planUpdates:[],memories:[],forgetMemories:[],...more})}}]});
const response=(kind,quote,answer,operations=[])=>({kind,quote,answer,operations});
const memory=()=>memoryInputSchema.parse({kind:'preference',statement:'09:30以后开始',quote:'九点半以后开始',certainty:'confirmed',rule:'not_before',time:'09:30'});

test('一次不放日历的决定不能被泛化成全局长期偏好',()=>{
 const quote='先不要塞进日历';
 const candidate=memoryInputSchema.parse({kind:'preference',statement:'轻量事项希望只作为待办记录，不要放进日历占用时段',quote,certainty:'confirmed'});
 const [saved]=prepareMemories([candidate],[],quote,'one-off',emptyData());
 assert.equal(saved.kind,'context');assert.equal(saved.date,localDay());assert.equal(saved.statement,quote);
 const habitual={...candidate,quote:'以后轻量事项都不要塞进日历'};
 const [standing]=prepareMemories([habitual],[],habitual.quote,'habit',emptyData());assert.equal(standing.kind,'preference');assert.equal(standing.date,null);
});
test('下周一与跨年相对日期由程序换算',()=>{assert.equal(relativeDate('下周一验收','2026-09-16'),'2026-09-21');assert.equal(relativeDate('下周一','2026-12-30'),'2027-01-04');assert.equal(relativeDate('后天','2026-12-31'),'2027-01-02')});

test('同轮回答文件位置并提出安排，保留两种意图而不以摘要替换回答',()=>{
 const r=parseConversation(tool([response('read','文件在哪','工程在公司笔记本 D:/Projects。'),response('change','明天十点安排','给你留一小时。',[block()])]),emptyData(),'mixed-turn','文件在哪，明天十点安排',[],[]);
 assert.match(r.reply,/公司笔记本/);assert.match(r.reply,/新增日程/);assert.equal(r.draft.operations.length,1);
});
test('保存状态从当前记录生成，不复述模型的过期状态',()=>{
 const data=applyOperations(emptyData(),[block()],'seed');
 const r=parseConversation(tool([response('status','存了什么','工作b还没有保存')]),data,'status-turn','存了什么',[],[]);
 assert.match(r.reply,/已保存日程/);assert.match(r.reply,/工作b/);assert.doesNotMatch(r.reply,/还没有保存/);assert.equal(r.draft,null);
});
test('没有操作的答复不能凭空声称改了项目或有待确认方案',()=>{
 assert.throws(()=>parseConversation(tool([response('preference','只是内部目标','我把项目目标改成内部目标，这条要你点应用才会生效')]),emptyData(),'phantom-turn','只是内部目标',[],[]),/没有任何方案/);
});
test('独立会议可以关联联系人，受其最早空闲时间约束',()=>{
 const data=emptyData();data.contacts=[{id:'lin',name:'林岚',wechat:'',notes:'',roles:[]}];
 const m={...prepareMemories([memory()],[],'九点半以后开始','m',data)[0],subjectId:'lin',time:'16:45'};
 const op={type:'block.save',data:{...block().data,contactId:'lin',start:'2026-09-17T16:30',end:'2026-09-17T17:00'}};
 assert.ok(constraintViolations(data,[op],[m]).length);
 const after=applyOperations(applyOperations(data,[op],'seed'),[{type:'contact.delete',id:'lin'}],'delete');assert.equal(after.blocks[0].contactId,'');
});
test('总结不能夹带写操作；已保存相同安排不再出方案',()=>{
 assert.throws(()=>parseConversation(tool([response('status','总结','总结',[block()])]),emptyData(),'summary-turn','总结',[],[]),/不能包含修改/);
 assert.throws(()=>parseConversation(tool([response('change','只帮我总结，别改安排','总结',[block()])]),emptyData(),'summary-misclassified','只帮我总结，别改安排',[],[]),/不能提出写入/);
 const d=applyOperations(emptyData(),[block()],'seed');const r=parseConversation(tool([response('change','十点','十点已有安排',[block()])]),d,'same-turn','十点',[],[]);assert.equal(r.draft,null);
});
test('撤回已保存日程使用删除操作，不因withdraw分类误拒绝',()=>{
 const data=applyOperations(emptyData(),[block()],'seed');const r=parseConversation(tool([response('withdraw','取消会面','',[{type:'block.delete',id:'b'}])]),data,'cancel-turn','取消会面',[],[]);
 assert.equal(r.draft.operations[0].type,'block.delete');assert.match(r.reply,/删除日程/);
});
test('供应商字符串数组和外层记录编号被规范化；冲突编号仍拒绝',()=>{
 const envelope=tool([]);envelope.tool_calls[0].function.arguments=JSON.stringify({responses:JSON.stringify([response('change','安排','',[{type:'block.save',id:'b',data:{...block().data,id:undefined}}])]),memories:'[]',planUpdates:'[]',forgetMemories:'[]'});
 assert.equal(parseConversation(envelope,emptyData(),'normal-turn','安排',[],[]).draft.operations[0].data.id,'b');
 assert.throws(()=>parseConversation(tool([response('change','安排','',[{...block(),id:'different'}])]),emptyData(),'bad-turn','安排',[],[]),/不一致/);
});
test('部分改口不能静默回退同一记录的另一个待确认字段',()=>{
 const data=applyOperations(emptyData(),[block()],'seed'),renamed={...block(),data:{...block().data,name:'新名字'}};
 const pending=[{id:'rename-apply',summary:'改名',workRevision:1,operations:[renamed],baseline:captureBaseline(data,[renamed])}];
 const moved={...block(),data:{...block().data,start:'2026-09-17T10:30'}};
 assert.throws(()=>parseConversation(tool([response('change','改到十点半','改时间',[moved])],{planUpdates:[{id:'rename-apply',action:'supersede',quote:'改到十点半'}]}),data,'move-turn','改到十点半',pending,[]),/不能丢掉旧方案/);
});
test('替换方案保留未涉及的另一条安排，独立方案保持待确认',async()=>{
 const {db,snapshot,sql}=database(),ops=[block('a'),block('b')];await commitChat(db,'owner',snapshot(),'old-plan','安排两个','待确认',{summary:'两个',operations:ops},0,captureBaseline(snapshot().data,ops));
 const pending=await allPendingPlans(db,'owner');const changed={...block('a'),data:{...block('a').data,name:'修改后的工作'}};
 const r=parseConversation(tool([response('change','改第一个','改好了草案',[changed])],{planUpdates:[{id:'old-plan-apply',action:'supersede',quote:'改第一个'}]}),snapshot().data,'new-plan','改第一个',pending,[]);
 assert.deepEqual(r.draft.operations.map(o=>o.data.id),['a','b']);
 await commitChat(db,'owner',snapshot(),'new-plan','改第一个',r.reply,r.draft,0,captureBaseline(snapshot().data,r.draft.operations),r.conversation);
 assert.equal((await readChatReceipt(db,'owner','old-plan')).proposal_state,'superseded');assert.equal((await allPendingPlans(db,'owner')).length,1);sql.close();
});
test('创建后删除不会复活原创建方案；关闭方案不能直接应用',async()=>{
 const {db,snapshot,sql}=database(),ops=[block()];await commitChat(db,'owner',snapshot(),'old-create','安排','待确认',{summary:'新建',operations:ops},0,captureBaseline(snapshot().data,ops));
 let current=snapshot();await commitWorkspace(db,'owner',current,applyOperations(current.data,ops,'manual'),'manual');
 assert.equal((await readChatReceipt(db,'owner','old-create')).proposal_state,'satisfied');
 current=snapshot();await commitWorkspace(db,'owner',current,applyOperations(current.data,[{type:'block.delete',id:'b'}],'delete'),'delete');
 current=snapshot();assert.equal(await commitWorkspace(db,'owner',current,applyOperations(current.data,ops,'old-create-apply'),'old-create-apply'),false);assert.equal(snapshot().data.blocks.length,0);sql.close();
});
test('备份恢复导致引用对象消失会永久关闭相关方案',async()=>{
 const {db,snapshot,sql,update}=database();const d=emptyData();d.projects=[{id:'p',name:'项目',goal:'',status:'active',start:'2026-09-16',end:'2026-09-20',color:'green'}];update(d);
 const op={type:'task.save',data:{id:'t',projectId:'p',name:'事项',shortName:'事',description:'',start:'2026-09-17',end:'2026-09-17',status:'todo',owner:'',hours:1,dependencies:[],contactId:'',updatedAt:'',result:''}};
 await commitChat(db,'owner',snapshot(),'new-task','安排','待确认',{summary:'事项',operations:[op]},0,captureBaseline(snapshot().data,[op]));
 await commitRestore(db,'owner',snapshot(),emptyData(),'restore-1','h');assert.equal((await readChatReceipt(db,'owner','new-task')).proposal_state,'invalidated');sql.close();
});
test('原话证据和真实日期校验，记忆按用户隔离并跨长对话保留',async()=>{
 const {db,snapshot,sql}=database();assert.throws(()=>prepareMemories([memory()],[],'没有说过','m',emptyData()),/原话/);assert.equal(memoryInputSchema.safeParse({...memory(),time:'09:99'}).success,false);assert.equal(memoryInputSchema.safeParse({...memory(),date:'2026-02-30'}).success,false);
 const memories=prepareMemories([memory()],[],'我九点半以后开始','first',emptyData());await commitChat(db,'owner',snapshot(),'first-turn','我九点半以后开始','记住了',null,0,undefined,{memories});
 for(let i=0;i<15;i++)await commitChat(db,'owner',snapshot(),'long-turn-'+i,'闲聊','收到',null,0);
 assert.equal((await readMemories(db,'owner','2026-09-17')).length,1);assert.equal((await readMemories(db,'other','2026-09-17')).length,0);sql.close();
});
test('慢请求不覆盖新偏好，记忆与旧方案转换在CAS失败时全不写',async()=>{
 const {db,snapshot,sql}=database(),before=snapshot();const memories=prepareMemories([memory()],[],'九点半以后开始','fresh',emptyData());await commitChat(db,'owner',before,'fresh-turn','九点半以后开始','记住',null,0,undefined,{memories});
 assert.equal(await commitChat(db,'owner',before,'slow-turn','十点','旧上下文',null,0,undefined,{memories:[{...memories[0],time:'10:00'}],forgotten:[memories[0].id]}),null);
 assert.equal((await readMemories(db,'owner','2026-09-17'))[0].time,'09:30');assert.equal(await readChatReceipt(db,'owner','slow-turn'),null);sql.close();
});
test('临时早起例外不覆盖长期作息；隔天仍恢复09:30约束',()=>{
 const known=prepareMemories([memory()],[],'九点半以后开始','regular',emptyData());
 const temporary=prepareMemories([{...memory(),id:known[0].id,date:'2026-09-17',time:'09:00',quote:'明天可以九点'}],known,'明天可以九点','temporary',emptyData());
 assert.notEqual(temporary[0].id,known[0].id);assert.equal(constraintViolations(emptyData(),[block('early','09:00')],[...known,...temporary]).length,0);
 const next={...block('next','09:00'),data:{...block('next','09:00').data,start:'2026-09-18T09:00',end:'2026-09-18T10:00'}};assert.ok(constraintViolations(emptyData(),[next],[...known,...temporary]).length);
 const updated=prepareMemories([{...memory(),time:'08:00',quote:'以后八点'}],known,'以后八点','change',emptyData());assert.equal(updated[0].id,known[0].id);
});
test('固定标记、独立日程不能绕过作息；通勤使用最终目标时段',()=>{
 const memories=prepareMemories([memory()],[],'九点半以后开始','m',emptyData());assert.ok(constraintViolations(emptyData(),[block('early','09:00',true)],memories).length);
 const pickup={...block('pickup').data,name:'接孩子',start:'2026-09-17T17:30',end:'2026-09-17T18:30',fixed:true};const data=applyOperations(emptyData(),[{type:'block.save',data:pickup}],'seed');
 const travel={...memories[0],rule:'travel_before',time:null,minutes:30,subjectId:'pickup',statement:'接孩子前需要半小时'};
 const meeting={...block('meeting').data,start:'2026-09-17T16:45',end:'2026-09-17T17:15'};
 assert.ok(constraintViolations(data,[{type:'block.save',data:meeting}],[travel]).length);
 assert.equal(constraintViolations(data,[{type:'block.save',data:meeting},{type:'block.save',data:{...pickup,start:'2026-09-17T18:00',end:'2026-09-17T19:00'}}],[travel]).length,0);
 const existing=applyOperations(data,[{type:'block.save',data:meeting},{type:'block.save',data:{...pickup,start:'2026-09-17T18:00',end:'2026-09-17T19:00'}}],'later');
 assert.ok(constraintViolations(existing,[{type:'block.save',data:pickup}],[travel]).length);
 existing.blocks.find(b=>b.id==='meeting').fixed=true;
 assert.ok(constraintViolations(existing,[{type:'block.save',data:pickup}],[travel]).length);
});
