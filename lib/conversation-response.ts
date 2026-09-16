import {z} from 'zod';
import {applyOperations,operationSchema,localDay,type Data} from './domain.ts';
import {relativeDate} from './conversation-dates.ts';
import {describeChanges} from './planning.ts';
import {stable,mergeChanges} from './changes.ts';
import {effectiveOperations,targetOf,type PlanTransition} from './proposal-lifecycle.ts';
import {memoryInputSchema,prepareMemories,mergeMemories,constraintViolations,type ConversationMemory} from './conversation-memory.ts';
import {type ReviewablePlan} from './proposal-review.ts';
import {dayPlanSchema,makeDayPlan} from './daily-planning.ts';

export const conversationSchema=z.object({
 responses:z.array(z.object({quote:z.string().min(1),kind:z.enum(['read','change','withdraw','preference','constraint','social','status']),answer:z.string().max(6000).default(''),dayPlan:dayPlanSchema.nullable().optional(),operations:z.array(operationSchema.and(z.object({changedFields:z.array(z.string()).optional()}))).max(30).default([])})).min(1).max(12),
 planUpdates:z.array(z.object({id:z.string(),action:z.enum(['supersede','dismiss']),quote:z.string().min(1)})).max(20).default([]),
 memories:z.array(memoryInputSchema).max(12).default([]),
 forgetMemories:z.array(z.object({id:z.string(),quote:z.string().min(1)})).max(12).default([]),
});
const key=(op:Parameters<typeof targetOf>[0])=>{const t=targetOf(op);return t.kind+':'+t.id};
const summaryOnly=(s:string)=>/(?:只|就)(?:帮我)?(?:总结|收个尾|梳理现状)|别(?:再)?(?:出方案|改安排|修改)|不要(?:修改|出方案|改动)/.test(s);

// Validate the whole turn before committing any answer, memory, or plan state.
export function parseConversation(message:any,data:Data,requestId:string,text:string,pending:ReviewablePlan[],known:ConversationMemory[],closedPlans:{request_id:string;proposal_state:string}[]=[]){
 if(message?.tool_calls?.length!==1||message.tool_calls[0].function.name!=='respond_to_user')throw new Error('必须恰好调用一次 respond_to_user');
 const args=JSON.parse(message.tool_calls[0].function.arguments);
 // Provider adapters sometimes serialize nested arrays or put a record key
 // beside data. Canonicalize representation; conflicting keys still fail.
 for(const field of ['responses','planUpdates','memories','forgetMemories'])if(typeof args[field]==='string')args[field]=JSON.parse(args[field]);
 for(const m of Array.isArray(args.memories)?args.memories:[])if(m.id===null||m.id==='')delete m.id;
 for(const r of Array.isArray(args.responses)?args.responses:[]){if(typeof r.operations==='string')r.operations=JSON.parse(r.operations);for(const op of Array.isArray(r.operations)?r.operations:[])if(op.type?.endsWith('.save')&&op.id&&op.data&&typeof op.data==='object'&&!op.data.id)op.data.id=op.id;}
 const turn=conversationSchema.parse(args);
 const replacesDaySlot=(op:{type:string;data?:unknown})=>op.type==='block.save'&&!(op.data as any)?.fixed&&turn.responses.some(r=>r.dayPlan&&(op.data as any)?.start?.startsWith(r.dayPlan.date));
 if(turn.responses.filter(r=>r.dayPlan).length>1)throw new Error('每轮只提交一份综合日程建议。');
 for(const r of turn.responses)if(r.dayPlan){
  if(r.kind!=='change'||r.operations.length)throw new Error('自动挑选事项只需 change + dayPlan，不要同时手写操作。');
  const changes=turn.responses.filter(other=>other!==r).flatMap(other=>other.operations),targets=new Set(changes.map(key));
  for(const update of turn.planUpdates.filter(u=>u.action==='supersede')){const old=pending.find(p=>p.id.replace(/-apply$/,'')===update.id.replace(/-apply$/,''));if(old)changes.push(...old.operations.filter(o=>!targets.has(key(o))&&!replacesDaySlot(o)));}
  const projected=changes.length?applyOperations(data,changes,'preview-'+requestId):data;
  const newMemories=prepareMemories(turn.memories.map(m=>m.id&&known.some(k=>k.id===m.id)?m:{...m,id:undefined}),known,text,requestId,projected);
  const plan=makeDayPlan(projected,r.dayPlan,mergeMemories(known,newMemories,turn.forgetMemories.map(m=>m.id)),requestId);r.operations=plan.operations;r.answer=plan.explanation;
 }
 for(const r of turn.responses)for(const op of r.operations)if(op.type==='block.save'){
  const b=op.data as any;if(b&&!b.contactId){const people=data.contacts.filter(c=>b.name?.includes(c.name));if(people.length===1)b.contactId=people[0].id;}
 }
 for(const r of turn.responses)for(const op of r.operations)if(op.type==='capture.save'&&!data.captures.some(c=>c.id===(op.data as any)?.id)){const c=op.data as any;op.data={...c,notes:r.quote,createdAt:new Date().toISOString()};}
 const quoted=(q:string)=>{if(!text.includes(q))throw new Error('意图和记忆的 quote 必须逐字引用本轮用户的话。')};
 for(const r of turn.responses){const expected=relativeDate(r.quote,localDay());const dated=r.operations.filter(o=>o.type.endsWith('.save')&&((o.data as any)?.start||(o.data as any)?.dueAt||(o.data as any)?.reviewOn));if(expected&&dated.length&&!dated.some(o=>{const v=o.data as any;return [v.start,v.end,v.dueAt,v.reviewOn].some(s=>s?.startsWith(expected))}))throw new Error('本轮原话的相对日期应为 '+expected+'，请依据提供的日历表修正安排。');}
 const explicitFields=new Map(turn.responses.flatMap(r=>r.operations.map(op=>[key(op),op.changedFields||[]] as const)));
 let ops=turn.responses.flatMap(r=>{quoted(r.quote);if(r.kind!=='change'&&r.kind!=='withdraw'&&r.operations.length)throw new Error('只读意图不能包含修改：响应 kind='+r.kind+' 却包含 '+r.operations.map(o=>o.type).join(',')+'。报告资料到齐、改跟进状态也是业务修改，必须把这个响应的kind改为change；status仅用于查询已保存摘要。不要删除用户要求的操作。');if(r.kind==='withdraw'&&r.operations.some(o=>!o.type.endsWith('.delete')))throw new Error('withdraw只能删除已保存记录，保存其他新安排应使用change意图。');return r.operations.map(({changedFields,...op})=>op)});
 if(turn.responses.some(r=>r.operations.length&&summaryOnly(r.quote))||summaryOnly(text)&&ops.length&&!turn.responses.some(r=>r.operations.length&&!summaryOnly(r.quote)&&/(?:改到|安排|新增|删除|取消|挪到|改成)/.test(r.quote)))throw new Error('用户要求只总结或不改安排，本轮不能提出写入方案。');
 if(ops.some(o=>o.type==='message.add'))throw new Error('不能修改聊天记录。');
 const transitions:PlanTransition[]=[];
 for(const update of turn.planUpdates){
  quoted(update.quote);
  const rawId=update.id.replace(/-apply$/,''),old=pending.find(p=>p.id.replace(/-apply$/,'')===rawId);
  if(!old&&update.action==='supersede'&&ops.length&&closedPlans.some(p=>p.request_id===rawId&&p.proposal_state==='applied'))continue;
  if(!old)throw new Error('要替换或撤回的方案不是当前待确认方案。已经应用的方案不能 supersede/dismiss，修改已保存记录只需 operations。当前可更新方案：'+pending.map(p=>p.id).join('、'));
  if(transitions.some(t=>t.id===update.id.replace(/-apply$/,'')))throw new Error('不能重复更新同一方案。');
  if(update.action==='supersede'){
   if(!ops.length)throw new Error('替换方案需要提供新安排；单纯不要了应使用 dismiss。');
   for(const next of ops){
    const previous=old.operations.find(o=>key(o)===key(next));
    const base=old.baseline?.records.find(r=>r.kind+':'+r.id===key(next))?.value;
    if(previous?.type.endsWith('.save')&&next.type.endsWith('.save')&&base){
     for(const [field,value] of Object.entries(previous.data as Record<string,unknown>)){
      if(field==='updatedAt'||field==='id')continue;
      if(stable(value)!==stable(base[field])&&stable((next.data as any)?.[field])===stable(base[field])&&!explicitFields.get(key(next))?.includes(field))throw new Error('部分改口不能丢掉旧方案已决定的字段 '+field+'。保留原提议值；仅用户明确改回时将该字段加入 changedFields。');
     }
    }
   }
   // A partial correction carries forward the independent parts of that plan.
   const targets=new Set(ops.map(key)),carried=old.baseline?mergeChanges(data,old.operations,old.baseline):old.operations;ops.push(...carried.filter(o=>!targets.has(key(o))&&!replacesDaySlot(o)));
  }
  transitions.push({id:update.id.replace(/-apply$/,''),state:update.action==='dismiss'?'dismissed':'superseded',reason:'根据你的新决定：'+update.quote,...(update.action==='supersede'?{replacementId:requestId}:{})});
 }
 const retained=pending.filter(p=>!transitions.some(t=>t.id===p.id.replace(/-apply$/,'')));
 if(ops.some(op=>retained.some(p=>p.operations.some(old=>key(old)===key(op)&&stable(old)!==stable(op)))))throw new Error('正在修改已有待确认安排，必须通过 planUpdates 替换原方案，不能让冲突版本同时有效。');
 // Repeating an unchanged pending operation must not produce a second card.
 ops=ops.filter(op=>!retained.some(p=>p.operations.some(old=>stable(old)===stable(op))));
 const targets=ops.map(key);if(new Set(targets).size!==targets.length)throw new Error('同一条记录有重复修改，请合并成最终决定。');
 ops=effectiveOperations(data,ops);
 if(ops.length>30)throw new Error('一次最多30项修改。');
 if(ops.length)applyOperations(data,ops,'validate-'+requestId);
 // Only the server assigns new memory IDs. An invented provider key can never
 // overwrite a memory outside the exact supplied owner context.
 const memories=prepareMemories(turn.memories.map(m=>m.id&&known.some(k=>k.id===m.id)?m:{...m,id:undefined}),known,text,requestId,data);
 const forgotten=turn.forgetMemories.map(f=>{quoted(f.quote);if(!known.some(m=>m.id===f.id))throw new Error('无法忘记不存在的记忆。');return f.id});
 if(memories.some(m=>forgotten.includes(m.id)))throw new Error('同一条记忆不能同时更新和遗忘。');
 const violations=constraintViolations(data,ops,mergeMemories(known,memories,forgotten));
 if(violations.length)throw new Error('安排违反用户已确认的限制，请重新计算可行时间或询问，不要提供不可能的安排：'+violations.join('；'));
 const draft=ops.length?{summary:describeChanges(data,ops),operations:ops}:null;
 if(!draft&&transitions.some(t=>t.state==='superseded'))throw new Error('没有实际新变更，不能声称生成替换方案。');
 let reply=turn.responses.map(r=>{
  // Action receipts and saved-state summaries are compiled from records, not
  // free prose. Other intent answers retain their conversational wording.
  const asksStatus=r.kind==='read'&&/收个尾|存了什么|哪些.{0,12}(?:存|确认)|还要点|当前.{0,12}(?:保存|确认)/.test(r.quote)&&!/(?:哪台|文件|工程|联系|微信)/.test(r.quote);
  if(r.kind==='status'||asksStatus)return savedStatusSummary(data,[...retained,...(draft?[{...draft,id:requestId+'-apply',workRevision:data.workRevision}]:[])]);
  if((r.kind==='change'||r.kind==='withdraw')&&r.operations.length){const keys=new Set(r.operations.map(key)),actual=ops.filter(o=>keys.has(key(o)));return actual.length?describeChanges(data,actual):'这部分已在当前安排或现有待确认方案中，无需重复创建。';}
  return r.answer.trim();
 }).filter((v,i,a)=>a.indexOf(v)===i).join('\n\n');
 if(!draft&&!retained.length&&/(?:这(?:条|份|些|个)|本次).{0,35}(?:待确认|应用才|点应用)|我把(?:项目|日程|事项|会议|待办).{0,70}(?:改成|安排|创建|删除)|已为你(?:安排|创建|删除).{0,15}(?:日程|事项|项目)/.test(reply))throw new Error('回复声称生成了修改或要求应用，但本轮没有任何方案。若只是记住用户的更正，就说明已记住，不要声称修改项目或生成方案。');
 if(/(?:回一句|回复|你说|说)[“「"']?应用[”」"']?(?:我就|才会|即可|就会|就能)/.test(reply))throw new Error('本产品需要点击待确认方案中的应用按钮，回复“应用”不会执行保存。请修正操作说明。');
 const awaiting=new Set([...retained.flatMap(p=>p.operations),...ops].map(key));
 for(const clause of reply.split(/[。；\n]/)){
  if(/不是待确认|并非待确认|不再.{0,3}待确认/.test(clause))continue;
  if(!/(?:还是|仍是|仍然|尚|还|均|都|目前|处于|是).{0,8}(?:待确认|未保存|没保存|未应用)/.test(clause))continue;
  const saved=[...data.tasks.map(v=>({kind:'task',id:v.id,names:[v.name,v.shortName]})),...data.blocks.map(v=>({kind:'block',id:v.id,names:[v.name]}))].filter(v=>v.names.some(n=>n.length>=2&&clause.includes(n)));
  if(saved.length&&saved.every(v=>!awaiting.has(v.kind+':'+v.id)))throw new Error('状态误报：这句话提到的事项/日程已经保存在当前工作空间，并没有针对它们的待确认变更：'+clause);
 }
 if(draft)reply+='\n\n新安排已整理为待确认方案，应用后才会保存。';
 if(!reply.trim())throw new Error('请给用户一句自然的回应，不能只返回空答案。');
 return {reply,draft,conversation:{memories,forgotten,transitions,audit:{intents:turn.responses.map(({quote,kind})=>({quote,kind})),planUpdates:turn.planUpdates}}};
}

function savedStatusSummary(data:Data,pending:ReviewablePlan[]){
 const states:Record<string,string>={todo:'待开始',doing:'进行中',waiting:'等待跟进',done:'已完成',paused:'暂停'};
 const extras='\n\n待整理：\n'+(data.captures.filter(c=>c.status==='inbox').slice(0,12).map(c=>'• '+c.name+(c.reviewOn?'（'+c.reviewOn+' 再看）':'')).join('\n')||'暂无随手记。')+'\n\n等待跟进：\n'+(data.followups.filter(f=>f.status==='waiting').slice(0,12).map(f=>'• '+f.name+'：'+f.dueAt.replace('T',' ')+(f.blocksTask?'，收到前关联事项暂不能推进':'')).join('\n')||'暂无待跟进。');
 const tasks=data.tasks.slice(0,12).map(t=>'• '+(data.projects.find(p=>p.id===t.projectId)?.name||'')+' · '+t.name+'：'+t.start+(t.end===t.start?'':' 至 '+t.end)+'，'+states[t.status]);
 const blocks=data.blocks.slice().sort((a,b)=>a.start.localeCompare(b.start)).slice(0,12).map(b=>'• '+b.name+'：'+b.start.replace('T',' ')+' 至 '+b.end.replace('T',' ')+(b.fixed?'（固定）':'')+(b.done?'，已完成':''));
 return '当前已经保存：\n'+(tasks.length?tasks.join('\n'):'暂无事项。')+(data.tasks.length>12?'\n另有 '+(data.tasks.length-12)+' 件事项，可在项目全景查看。':'')+'\n\n已保存日程：\n'+(blocks.length?blocks.join('\n'):'暂无日程。')+(data.blocks.length>12?'\n另有 '+(data.blocks.length-12)+' 段日程，可在我的日程查看。':'')+extras+'\n\n待确认：'+(pending.length?'\n'+pending.slice(0,8).map(p=>'• '+p.summary).join('\n')+(pending.length>8?'\n另有 '+(pending.length-8)+' 份方案。':'')+'\n点击待确认方案中的应用按钮后才会保存。':'目前没有待确认方案。');
}

export const conversationTool={type:'function',function:{name:'respond_to_user',description:'完整回应本轮所有意图：同时回答问题、给出修改草案、撤回旧方案和记住用户明确说出的事实。操作不会自动应用。',parameters:zodParameters()}};
function zodParameters(){return {type:'object',properties:{
 responses:{type:'array',items:{type:'object',properties:{quote:{type:'string',description:'本轮用户的连续原话，逐字引用。'},kind:{type:'string',enum:['read','change','withdraw','preference','social','status']},answer:{type:'string'},dayPlan:{type:['object','null'],description:'按明确时间窗与新增投入自动挑事；填写时operations留空',properties:{date:{type:'string'},start:{type:'string'},end:{type:'string'},minutes:{type:'integer'},energy:{type:'string',enum:['focus','light']}},required:['date','start','end','minutes','energy']},operations:{type:'array',items:{type:'object',properties:{type:{type:'string',enum:['project.save','project.delete','task.save','task.delete','block.save','block.delete','contact.save','contact.delete','resource.save','resource.delete','capture.save','capture.delete','followup.save','followup.delete']},id:{type:'string'},changedFields:{type:'array',items:{type:'string'},description:'用户明确更改的字段名，用于保留同一记录中其他待确认决定。'},data:{type:'object'}},required:['type']}}},required:['quote','kind','answer','operations']}},
 planUpdates:{type:'array',items:{type:'object',properties:{id:{type:'string'},action:{type:'string',enum:['supersede','dismiss']},quote:{type:'string'}},required:['id','action','quote']}},
 memories:{type:'array',items:{type:'object',properties:{id:{type:'string'},kind:{type:'string',enum:['preference','constraint','context','open_request']},statement:{type:'string'},quote:{type:'string'},certainty:{type:'string',enum:['confirmed','tentative']},date:{type:['string','null']},subjectId:{type:'string'},rule:{type:'string',enum:['not_before','travel_before','none']},time:{type:['string','null']},minutes:{type:['number','null']}},required:['kind','statement','quote','certainty','date','subjectId','rule','time','minutes']}},
 forgetMemories:{type:'array',items:{type:'object',properties:{id:{type:'string'},quote:{type:'string'}},required:['id','quote']}},
 },required:['responses','planUpdates','memories','forgetMemories']};}
