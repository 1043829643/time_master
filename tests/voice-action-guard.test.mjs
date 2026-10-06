import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from './database.mjs';
import {applyOperations,emptyData,localDay,addDays} from '../lib/domain.ts';
import {captureBaseline} from '../lib/changes.ts';
import {parseConversation} from '../lib/conversation-response.ts';
import {guardVoiceTurn,explicitVoiceConfirmation,explicitVoiceWithdrawal,pendingVoiceTransitionsFromAudit,priorVoiceWithdrawalFromAudit,stagedVoiceAncestorIds,candidatePlanUpdateIds,inheritedVoiceTransitions,voiceConfirmationMatchesPlan} from '../lib/voice-action-guard.ts';
import {resolveExecution} from '../lib/agent-execution.ts';
import {commitChat,commitWorkspace,allPendingPlans,readChatReceipt} from '../lib/chat-state.ts';
import {readMemories} from '../lib/conversation-memory.ts';

const tool=args=>({tool_calls:[{function:{name:'respond_to_user',arguments:JSON.stringify({execution:{mode:'preview',quote:''},responses:[],planUpdates:[],memories:[],forgetMemories:[],...args})}}]});
const project={type:'project.save',data:{id:'p',name:'时间大师',start:addDays(localDay(),1),end:addDays(localDay(),5)}};

test('语音半句中的明确删除动词只能创建待确认方案，不写工作区',async()=>{
 const d=database();d.update(applyOperations(emptyData(),[project],'seed'));
 const text='把时间大师项目删了',operation={type:'project.delete',id:'p'};
 const parsed=parseConversation(tool({execution:{mode:'execute',quote:text},responses:[{quote:text,kind:'change',answer:'处理',operations:[operation]}]}),d.snapshot().data,'voice-delete',text,[],[]);
 const safe=guardVoiceTurn(parsed,text);
 assert.equal(safe.execution.mode,'preview');
 assert.match(safe.reply,/还没有保存/);
 const decision=resolveExecution(d.snapshot().data,safe.draft,safe.execution,text,[],[]);
 assert.equal(decision.execution,undefined);
 await commitChat(d.db,'owner',d.snapshot(),'voice-delete',text,safe.reply,decision.draft,d.snapshot().data.workRevision,captureBaseline(d.snapshot().data,decision.draft.operations),safe.conversation);
 assert.equal(d.snapshot().data.projects.length,1);
 assert.equal((await readChatReceipt(d.db,'owner','voice-delete')).proposal_state,'pending');
});

test('语音改口先暂存替换意图；明确确认新方案时才原子替换旧方案',async()=>{
 const d=database(),firstDay=addDays(localDay(),3),nextDay=addDays(localDay(),4);
 const first={type:'block.save',data:{id:'discussion',name:'讨论会',start:firstDay+'T14:00',end:firstDay+'T15:00'}};
 const changed={type:'block.save',data:{id:'discussion',name:'讨论会',start:nextDay+'T14:00',end:nextDay+'T15:00'}};
 const oldBase=captureBaseline(d.snapshot().data,[first]);
 await commitChat(d.db,'owner',d.snapshot(),'old-voice','周三下午两点安排讨论会','待确认',{summary:'周三讨论会',operations:[first]},0,oldBase);
 const text='不对，改到周四下午两点',pending=await allPendingPlans(d.db,'owner');
 const parsed=parseConversation(tool({execution:{mode:'execute',quote:'改到周四下午两点'},responses:[{quote:'改到周四下午两点',kind:'change',answer:'改期',operations:[changed]}],planUpdates:[{id:'old-voice-apply',action:'supersede',quote:'改到周四下午两点'}]}),d.snapshot().data,'new-voice',text,pending,[]);
 const safe=guardVoiceTurn(parsed,text);
 assert.equal(safe.conversation.transitions.length,0);
 assert.equal(safe.pendingTransitions.length,1);
 assert.match(safe.reply,/原来的待确认方案.*确认.*替换/);
 const base=captureBaseline(d.snapshot().data,safe.draft.operations);
 await commitChat(d.db,'owner',d.snapshot(),'new-voice',text,safe.reply,safe.draft,0,base,safe.conversation);
 assert.equal((await readChatReceipt(d.db,'owner','old-voice')).proposal_state,'pending');
 const row=await d.db.prepare('SELECT turn_context FROM chat_receipts WHERE owner=? AND request_id=?').bind('owner','new-voice').first();
 const delayed=pendingVoiceTransitionsFromAudit(row.turn_context);
 assert.equal(delayed[0].id,'old-voice');
 const currentPending=await allPendingPlans(d.db,'owner');
 const confirmation='确认保存第一份方案';
 const confirmParsed=parseConversation(tool({execution:{mode:'confirm',quote:confirmation,proposalId:'new-voice'},responses:[{quote:confirmation,kind:'change',answer:'确认',operations:[]}]}),d.snapshot().data,'confirm-voice',confirmation,currentPending,[]);
 const guarded=guardVoiceTurn(confirmParsed,confirmation);
 assert.equal(guarded.execution.mode,'confirm');
 const execution=resolveExecution(d.snapshot().data,guarded.draft,guarded.execution,confirmation,currentPending,[]).execution;
 assert.equal(execution.sourceProposalId,'new-voice');
 await commitChat(d.db,'owner',d.snapshot(),'confirm-voice',confirmation,'已保存',null,0,undefined,{...guarded.conversation,execution,transitions:delayed,requiredPendingTransitionIds:delayed.map(t=>t.id)});
 assert.equal(d.snapshot().data.blocks[0].start,nextDay+'T14:00');
 assert.equal((await readChatReceipt(d.db,'owner','old-voice')).proposal_state,'superseded');
 assert.equal((await readChatReceipt(d.db,'owner','new-voice')).proposal_state,'applied');
});

test('A→B→C 连续两次改口继承旧方案链；有另一独立方案时点名确认 C 可完整应用',async()=>{
 const d=database(),firstDay=addDays(localDay(),2),secondDay=addDays(localDay(),3),thirdDay=addDays(localDay(),4);
 const block=(day)=>({type:'block.save',data:{id:'review-meeting',name:'讨论会',start:day+'T14:00',end:day+'T15:00'}});
 const a=block(firstDay),b=block(secondDay),c=block(thirdDay);
 await commitChat(d.db,'owner',d.snapshot(),'plan-a','先安排讨论会','预览',{summary:'讨论会',operations:[a]},0,captureBaseline(d.snapshot().data,[a]));
 const stagedCorrection=async(id,oldId,op,words)=>{
  const all=await allPendingPlans(d.db,'owner');
  const audits=(await d.db.prepare("SELECT request_id,turn_context FROM chat_receipts WHERE owner=? AND proposal_state='pending' AND proposal IS NOT NULL").bind('owner').all()).results;
  const response=tool({execution:{mode:'execute',quote:words},responses:[{quote:words,kind:'change',answer:'改期',operations:[op]}],planUpdates:[{id:oldId+'-apply',action:'supersede',quote:words}]});
  const ancestors=stagedVoiceAncestorIds(all,new Map(audits.map(row=>[row.request_id,row.turn_context])),candidatePlanUpdateIds(response));
  let parsed;
  try{parsed=parseConversation(response,d.snapshot().data,id,words,all,[])}
  catch(e){assert.match(String(e),/正在修改已有待确认安排/);parsed=parseConversation(response,d.snapshot().data,id,words,all,[],[],ancestors)}
  const chain=await inheritedVoiceTransitions(parsed.conversation.transitions,async priorId=>{
   const row=await d.db.prepare('SELECT turn_context FROM chat_receipts WHERE owner=? AND request_id=?').bind('owner',priorId).first();
   return row?.turn_context||null;
  });
  const safe=guardVoiceTurn(parsed,words,[],chain);
  await commitChat(d.db,'owner',d.snapshot(),id,words,safe.reply,safe.draft,0,captureBaseline(d.snapshot().data,safe.draft.operations),safe.conversation);
  return safe;
 };
 await stagedCorrection('plan-b','plan-a',b,'改到第二天');
 const safeC=await stagedCorrection('plan-c','plan-b',c,'不对，再改到第三天');
 assert.equal(safeC.pendingTransitions.length,2);
 assert.deepEqual(new Set(safeC.pendingTransitions.map(t=>t.id)),new Set(['plan-a','plan-b']));
 assert.match(safeC.reply,/确认保存讨论会/);
 for(const id of ['plan-a','plan-b','plan-c'])assert.equal((await readChatReceipt(d.db,'owner',id)).proposal_state,'pending');
 const other={type:'project.save',data:{id:'other',name:'财务项目',start:thirdDay,end:thirdDay}};
 await commitChat(d.db,'owner',d.snapshot(),'other-plan','另一个项目','待确认',{summary:'财务项目',operations:[other]},0,captureBaseline(d.snapshot().data,[other]));
 const all=await allPendingPlans(d.db,'owner');
 const audits=(await d.db.prepare("SELECT request_id,turn_context FROM chat_receipts WHERE owner=? AND proposal_state='pending' AND proposal IS NOT NULL").bind('owner').all()).results;
 assert.deepEqual(new Set(all.map(p=>p.id)),new Set(['other-plan-apply','plan-c-apply','plan-b-apply','plan-a-apply']));
 const order=all.findIndex(p=>p.id==='plan-c-apply')+1;
 assert.ok(order>0);
 const confirmation='确认保存第'+order+'份方案';
 const approved=guardVoiceTurn(parseConversation(tool({execution:{mode:'confirm',quote:confirmation,proposalId:'plan-c'},responses:[{quote:confirmation,kind:'change',answer:'确认',operations:[]}]}),d.snapshot().data,'apply-c',confirmation,all,[]),confirmation);
 const execution=resolveExecution(d.snapshot().data,null,approved.execution,confirmation,all,[]).execution;
 assert.equal(execution.sourceProposalId,'plan-c');
 const row=await d.db.prepare('SELECT turn_context FROM chat_receipts WHERE owner=? AND request_id=?').bind('owner','plan-c').first();
 const delayed=pendingVoiceTransitionsFromAudit(row.turn_context);
 await commitChat(d.db,'owner',d.snapshot(),'apply-c',confirmation,'已保存',null,0,undefined,{...approved.conversation,execution,transitions:delayed,requiredPendingTransitionIds:delayed.map(t=>t.id)});
 assert.equal(d.snapshot().data.blocks[0].start,thirdDay+'T14:00');
 assert.equal((await readChatReceipt(d.db,'owner','plan-a')).proposal_state,'superseded');
 assert.equal((await readChatReceipt(d.db,'owner','plan-b')).proposal_state,'superseded');
 assert.equal((await readChatReceipt(d.db,'owner','plan-c')).proposal_state,'applied');
 assert.equal((await readChatReceipt(d.db,'owner','other-plan')).proposal_state,'pending');
});

test('只有明确替换当前更正方案时才忽略祖先草案，独立新操作不能绕过冲突校验',()=>{
 const audit=JSON.stringify({pendingVoiceTransitions:[{id:'older',state:'superseded',reason:'改口'}]});
 const plans=[{id:'newer-apply'},{id:'older-apply'}],audits=new Map([['newer',audit]]);
 const independent=tool({responses:[{quote:'另加一个',kind:'change',answer:'安排',operations:[]}]});
 assert.equal(stagedVoiceAncestorIds(plans,audits,candidatePlanUpdateIds(independent)).size,0);
 const replacing=tool({planUpdates:[{id:'newer-apply',action:'supersede',quote:'再次改口'}]});
 assert.deepEqual(stagedVoiceAncestorIds(plans,audits,candidatePlanUpdateIds(replacing)),new Set(['older']));
});

test('语音确认不能把说错名称的唯一方案当作“这份”直接应用',()=>{
 const plan={id:'visual-apply',summary:'新增项目「视觉项目」',operations:[{type:'project.save',data:{id:'visual',name:'视觉项目'}}]};
 assert.equal(voiceConfirmationMatchesPlan('确认保存这份方案',plan),true);
 assert.equal(voiceConfirmationMatchesPlan('确认保存第一份方案',plan),true);
 assert.equal(voiceConfirmationMatchesPlan('确认保存视觉项目',plan),true);
 assert.equal(voiceConfirmationMatchesPlan('确认保存财务项目',plan),false);
});

test('被替换旧方案状态若在确认瞬间改变，整个语音确认提交失败',async()=>{
 const d=database(),op={type:'project.save',data:{id:'guarded',name:'测试项目',start:addDays(localDay(),1),end:addDays(localDay(),1)}};
 await commitChat(d.db,'owner',d.snapshot(),'old-plan','原计划','预览',{summary:'旧计划',operations:[op]},0,captureBaseline(d.snapshot().data,[op]));
 await commitChat(d.db,'owner',d.snapshot(),'new-plan','改口','预览',{summary:'新计划',operations:[op]},0,captureBaseline(d.snapshot().data,[op]));
 const before=d.snapshot();
 await d.db.prepare("UPDATE chat_receipts SET proposal_state='dismissed' WHERE owner=? AND request_id=?").bind('owner','old-plan').run();
 const committed=await commitChat(d.db,'owner',before,'voice-approval','确认保存','已保存',null,0,undefined,{execution:{operations:[op],sourceProposalId:'new-plan'},transitions:[{id:'old-plan',state:'superseded',reason:'明确更正'}],requiredPendingTransitionIds:['old-plan']});
 assert.equal(committed,null);
 assert.equal(d.snapshot().data.projects.length,0);
 assert.equal(await readChatReceipt(d.db,'owner','voice-approval'),null);
});

test('待确认卡片应用语音更正时也要原子关闭旧方案',async()=>{
 const d=database(),day=addDays(localDay(),2),next=addDays(localDay(),3);
 const old={type:'block.save',data:{id:'card-block',name:'卡片测试会',start:day+'T10:00',end:day+'T11:00'}};
 const changed={type:'block.save',data:{id:'card-block',name:'卡片测试会',start:next+'T10:00',end:next+'T11:00'}};
 await commitChat(d.db,'owner',d.snapshot(),'card-old','原日期','预览',{summary:'旧安排',operations:[old]},0,captureBaseline(d.snapshot().data,[old]));
 const parsed=parseConversation(tool({execution:{mode:'execute',quote:'改到后一天'},responses:[{quote:'改到后一天',kind:'change',answer:'改期',operations:[changed]}],planUpdates:[{id:'card-old-apply',action:'supersede',quote:'改到后一天'}]}),d.snapshot().data,'card-new','改到后一天',await allPendingPlans(d.db,'owner'),[]);
 const safe=guardVoiceTurn(parsed,'改到后一天');
 await commitChat(d.db,'owner',d.snapshot(),'card-new','改到后一天',safe.reply,safe.draft,0,captureBaseline(d.snapshot().data,safe.draft.operations),safe.conversation);
 const metadata=await d.db.prepare('SELECT turn_context FROM chat_receipts WHERE owner=? AND request_id=?').bind('owner','card-new').first();
 const delayed=pendingVoiceTransitionsFromAudit(metadata.turn_context),before=d.snapshot();
 const after=applyOperations(before.data,safe.draft.operations,'card-new-apply','应用卡片');
 assert.equal(await commitWorkspace(d.db,'owner',before,after,'card-new-apply','hash',delayed),true);
 assert.equal(d.snapshot().data.blocks[0].start,next+'T10:00');
 assert.equal((await readChatReceipt(d.db,'owner','card-old')).proposal_state,'superseded');
 assert.equal((await readChatReceipt(d.db,'owner','card-new')).proposal_state,'applied');
});

test('含糊肯定、反问或后接改口不算语音确认；纯偏好语音仍能记住',async()=>{
 for(const value of ['好','对','确认保存？','确认保存，不过先别改','确认保存，不对，先等等'])assert.equal(explicitVoiceConfirmation(value),false,value);
 assert.equal(explicitVoiceConfirmation('确认保存这份方案'),true);
 const d=database(),text='以后周五不排会';
 const parsed=parseConversation(tool({execution:{mode:'reply',quote:''},responses:[{quote:text,kind:'preference',answer:'记住了',operations:[]}],memories:[{kind:'preference',statement:text,quote:text,certainty:'confirmed',date:null,subjectId:'',rule:'none',time:null,minutes:null}]}),d.snapshot().data,'voice-memory',text,[],[]);
 const safe=guardVoiceTurn(parsed,text);
 assert.equal(safe.conversation.memories.length,1);
 await commitChat(d.db,'owner',d.snapshot(),'voice-memory',text,safe.reply,null,0,undefined,safe.conversation);
 assert.equal((await readMemories(d.db,'owner',localDay())).length,1);
});

test('纯撤回须相邻第二轮明确确认同一份方案，才关闭待确认状态',async()=>{
 const d=database(),op={type:'project.save',data:{id:'withdraw-p',name:'视觉项目',start:addDays(localDay(),1),end:addDays(localDay(),2)}};
 await commitChat(d.db,'owner',d.snapshot(),'plan-to-withdraw','安排视觉项目','待确认',{summary:'视觉项目',operations:[op]},0,captureBaseline(d.snapshot().data,[op]));
 const pending=await allPendingPlans(d.db,'owner');
 const first='撤回视觉项目那份方案';
 const firstParsed=parseConversation(tool({responses:[{quote:first,kind:'withdraw',answer:'撤回',operations:[]}],planUpdates:[{id:'plan-to-withdraw-apply',action:'dismiss',quote:first}]}),d.snapshot().data,'withdraw-stage',first,pending,[]);
 const staged=guardVoiceTurn(firstParsed,first);
 assert.equal(staged.conversation.transitions.length,0);
 assert.match(staged.reply,/还没有改变原方案/);
 await commitChat(d.db,'owner',d.snapshot(),'withdraw-stage',first,staged.reply,null,0,undefined,staged.conversation);
 assert.equal((await readChatReceipt(d.db,'owner','plan-to-withdraw')).proposal_state,'pending');
 const row=await d.db.prepare('SELECT turn_context FROM chat_receipts WHERE owner=? AND request_id=?').bind('owner','withdraw-stage').first();
 const prior=priorVoiceWithdrawalFromAudit(row.turn_context);
 assert.equal(prior.length,1);
 const second='确认撤回视觉项目那份方案';
 assert.equal(explicitVoiceWithdrawal(second),true);
 const secondParsed=parseConversation(tool({responses:[{quote:second,kind:'withdraw',answer:'撤回',operations:[]}],planUpdates:[{id:'plan-to-withdraw-apply',action:'dismiss',quote:second}]}),d.snapshot().data,'withdraw-commit',second,pending,[]);
 const approved=guardVoiceTurn(secondParsed,second,prior,undefined,'视觉项目');
 assert.equal(approved.conversation.transitions.length,1);
 await commitChat(d.db,'owner',d.snapshot(),'withdraw-commit',second,approved.reply,null,0,undefined,{...approved.conversation,requiredPendingTransitionIds:approved.conversation.transitions.map(t=>t.id)});
 assert.equal((await readChatReceipt(d.db,'owner','plan-to-withdraw')).proposal_state,'dismissed');
 assert.equal(d.snapshot().data.projects.length,0);
});

test('确认撤回另一份方案或后接等等都不能沿用先前的语音授权',()=>{
 const prior=[{id:'old',state:'dismissed',reason:'旧方案'}];
 const result={reply:'撤回',draft:null,information:'',execution:{mode:'preview',quote:''},conversation:{memories:[],forgotten:[],transitions:[{id:'different',state:'dismissed',reason:'另一份'}],audit:{intents:[],planUpdates:[]}}};
 assert.equal(guardVoiceTurn(result,'确认撤回另一份方案',prior,undefined,'旧方案').conversation.transitions.length,0);
 assert.equal(guardVoiceTurn({...result,conversation:{...result.conversation,transitions:prior}},'确认撤回旧方案，等等',prior,undefined,'旧方案').conversation.transitions.length,0);
 const omitted={...result,execution:{mode:'confirm',quote:'确认撤回这份方案'},conversation:{...result.conversation,transitions:[]}};
 const recovered=guardVoiceTurn(omitted,'确认撤回这份方案',prior,undefined,'旧方案');
 assert.equal(recovered.conversation.transitions[0].id,'old');
 assert.equal(guardVoiceTurn(omitted,'确认撤回财务项目那份方案',prior,undefined,'视觉项目').conversation.transitions.length,0);
});

test('模型漏掉第二轮撤回工具字段时，服务器用上一轮唯一绑定目标完成撤回',async()=>{
 const d=database(),op={type:'project.save',data:{id:'model-missed',name:'视觉项目',start:addDays(localDay(),1),end:addDays(localDay(),2)}};
 await commitChat(d.db,'owner',d.snapshot(),'pending-missed','新项目','预览',{summary:'视觉项目',operations:[op]},0,captureBaseline(d.snapshot().data,[op]));
 const first='撤回视觉项目方案';
 const firstParsed=parseConversation(tool({responses:[{quote:first,kind:'withdraw',answer:'撤回',operations:[]}],planUpdates:[{id:'pending-missed-apply',action:'dismiss',quote:first}]}),d.snapshot().data,'stage-missed',first,await allPendingPlans(d.db,'owner'),[]);
 const firstGuard=guardVoiceTurn(firstParsed,first);
 await commitChat(d.db,'owner',d.snapshot(),'stage-missed',first,firstGuard.reply,null,0,undefined,firstGuard.conversation);
 const metadata=await d.db.prepare('SELECT turn_context FROM chat_receipts WHERE owner=? AND request_id=?').bind('owner','stage-missed').first();
 const previous=priorVoiceWithdrawalFromAudit(metadata.turn_context);
 const second='确认撤回这份方案';
 const modelOmission=parseConversation(tool({execution:{mode:'confirm',quote:second,proposalId:'pending-missed'},responses:[{quote:second,kind:'withdraw',answer:'好的',operations:[]}]}),d.snapshot().data,'commit-missed',second,await allPendingPlans(d.db,'owner'),[]);
 const safe=guardVoiceTurn(modelOmission,second,previous,undefined,'视觉项目');
 assert.equal(safe.execution.mode,'preview');
 assert.equal(safe.conversation.transitions[0].id,'pending-missed');
 await commitChat(d.db,'owner',d.snapshot(),'commit-missed',second,safe.reply,null,0,undefined,{...safe.conversation,requiredPendingTransitionIds:['pending-missed']});
 assert.equal((await readChatReceipt(d.db,'owner','pending-missed')).proposal_state,'dismissed');
});
