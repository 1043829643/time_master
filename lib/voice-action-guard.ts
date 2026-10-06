import {hasConfirmationReservation} from './agent-execution.ts';
import type {parseConversation} from './conversation-response.ts';
import type {PlanTransition} from './proposal-lifecycle.ts';
import type {ReviewablePlan} from './proposal-review.ts';
import {z} from 'zod';

type ConversationResult=ReturnType<typeof parseConversation>;

// Speech-recognition finals can end at a pause rather than at the end of a
// decision. A quoted command is evidence of what ASR heard, not consent to
// commit it. Only a separate, explicit confirmation can apply an existing plan.
export function explicitVoiceConfirmation(text:string){
 const value=text.replace(/\s+/g,'');
 if(/[?？]/.test(value)||hasConfirmationReservation(value)||/(?:不对|不是|等等|等下|先别|暂时别|还没|没有说完|再想想|不过|但是|只是)/.test(value))return false;
 return /(?:确认(?:保存|应用|执行)|(?:就)?按(?:这个|这份|刚才的|原)(?:方案|安排)?(?:保存|应用|执行)|照(?:这个|这份|刚才的|原)(?:方案|安排)?(?:保存|应用|执行))/.test(value);
}

export function voiceConfirmationMatchesPlan(text:string,plan:ReviewablePlan){
 const value=text.replace(/\s+/g,''),rest=value.replace(/^.*?(?:确认(?:保存|应用|执行)|(?:就)?按(?:这个|这份|刚才的|原)(?:方案|安排)?(?:保存|应用|执行)|照(?:这个|这份|刚才的|原)(?:方案|安排)?(?:保存|应用|执行))/,'').replace(/^[，,。；;:：]+/,'').replace(/[，,。；;:：]*(?:谢谢|好吧|辛苦了|可以了)[。！!]*$/,'');
 if(/^(?:(?:这|那)(?:份|个)?|刚才的?|原|旧|当前|第[一二三四五六七八九十\d]+份)?(?:待确认)?(?:方案|安排|项目|事项)?$/.test(rest))return true;
 const names=new Set([...plan.summary.matchAll(/「([^」]+)」/g)].map(match=>match[1]));
 for(const op of plan.operations){const name=(op.data as {name?:unknown}|undefined)?.name;if(typeof name==='string'&&name.trim())names.add(name.trim())}
 return [...names].some(name=>value.includes(name.replace(/\s+/g,'')));
}

export function explicitVoiceWithdrawal(text:string){
 const value=text.replace(/\s+/g,'');
 const withoutApproval=value.replace(/确认(?:撤回|放弃|取消)/g,'');
 if(/[?？]/.test(value)||hasConfirmationReservation(withoutApproval)||/(?:不对|不是|等等|等下|先别|暂时别|还没|没有说完|再想想|不过|但是|只是)/.test(value))return false;
 return /确认(?:撤回|放弃|取消)(?:这份|这个|刚才的|原)?(?:待确认)?方案|确认(?:撤回|放弃|取消)[^，。；,;]{0,24}(?:方案|安排)/.test(value);
}

function namesThePriorWithdrawal(text:string,summary:string){
 const value=text.replace(/\s+/g,''),subject=value.split(/确认(?:撤回|放弃|取消)/).at(-1)||'';
 if(/^(?:(?:这|那)(?:份|个)?|刚才的?|原|旧|之前的?|上一个)?(?:待确认)?(?:方案|安排)?$/.test(subject))return true;
 const names=[...summary.matchAll(/「([^」]+)」/g)].map(match=>match[1]);
 if(!names.length&&summary.length>=2&&summary.length<=40)names.push(summary);
 return names.some(name=>value.includes(name));
}

export type GuardedVoiceTurn=ConversationResult&{pendingTransitions:PlanTransition[]};

const pendingTransitionSchema=z.array(z.object({
 id:z.string().min(1),state:z.enum(['superseded','dismissed']),reason:z.string().min(1),replacementId:z.string().optional(),
})).max(20);

export function pendingVoiceTransitionsFromAudit(raw:string|null):PlanTransition[]{
 if(!raw)return [];
 let audit:unknown;
 try{audit=JSON.parse(raw)}catch{throw new Error('语音方案的待确认信息已损坏，请重新整理。')}
 if(!audit||typeof audit!=='object'||!('pendingVoiceTransitions' in audit))return [];
 const parsed=pendingTransitionSchema.safeParse((audit as {pendingVoiceTransitions:unknown}).pendingVoiceTransitions);
 if(!parsed.success)throw new Error('语音方案的待确认信息不完整，请重新整理。');
 return parsed.data;
}

export function priorVoiceWithdrawalFromAudit(raw:string|null):PlanTransition[]{
 if(!raw)return [];
 let audit:unknown;
 try{audit=JSON.parse(raw)}catch{return []}
 if(!audit||typeof audit!=='object'||(audit as {voiceSafety?:unknown}).voiceSafety!=='withdrawal-awaiting-confirmation')return [];
 const pending=pendingVoiceTransitionsFromAudit(raw);
 return pending.length===1&&pending[0].state==='dismissed'?pending:[];
}

export function candidatePlanUpdateIds(message:unknown):Set<string>{
 const call=(message as {tool_calls?:{function?:{arguments?:string}}[]}|null)?.tool_calls?.[0];
 if(typeof call?.function?.arguments!=='string')return new Set();
 try{
  const args=JSON.parse(call.function.arguments) as {planUpdates?:unknown};
  const updates=typeof args.planUpdates==='string'?JSON.parse(args.planUpdates) as unknown:args.planUpdates;
  return new Set(Array.isArray(updates)?updates.flatMap((item:unknown)=>item&&typeof item==='object'&&'id' in item&&typeof item.id==='string'?[item.id.replace(/-apply$/,'')]:[]):[]);
 }catch{return new Set()}
}

export function stagedVoiceAncestorIds<T extends {id:string}>(plans:T[],auditById:Map<string,string|null>,requestedIds:ReadonlySet<string>):Set<string>{
 const ancestors=new Set<string>();
 for(const plan of plans){
  const planId=plan.id.replace(/-apply$/,'');
  if(!requestedIds.has(planId))continue;
  for(const transition of pendingVoiceTransitionsFromAudit(auditById.get(planId)||null))if(transition.id!==planId)ancestors.add(transition.id);
 }
 return ancestors;
}

// A pending spoken correction may itself replace another pending correction.
// Keep the whole ancestry until the newest proposal is confirmed, so A→B→C
// closes A and B in the same transaction that applies C.
export async function inheritedVoiceTransitions(direct:PlanTransition[],readAudit:(id:string)=>Promise<string|null>):Promise<PlanTransition[]>{
 const all=new Map<string,PlanTransition>(),queue=[...direct];
 while(queue.length){
  const transition=queue.shift()!;
  if(all.has(transition.id))continue;
  all.set(transition.id,transition);
  if(all.size>40)throw new Error('语音更正链过长，请重新整理当前方案。');
  for(const inherited of pendingVoiceTransitionsFromAudit(await readAudit(transition.id)))if(!all.has(inherited.id))queue.push(inherited);
 }
 return [...all.values()];
}

/** Make ASR text conversational immediately, but stage all new business effects. */
export function guardVoiceTurn(result:ConversationResult,text:string,priorWithdrawal:PlanTransition[]=[],stagedTransitions:PlanTransition[]=result.conversation.transitions,priorWithdrawalSummary=''):GuardedVoiceTurn{
 const hasDraft=!!result.draft?.operations.length;
 const pendingTransitions=result.conversation.transitions;
 const hasMemoryEffects=!!(result.conversation.memories.length||result.conversation.forgotten.length);
 const isConfirmation=result.execution.mode==='confirm';
 const confirmed=isConfirmation&&explicitVoiceConfirmation(text)&&!pendingTransitions.length&&!hasDraft;
 if(confirmed)return {
  ...result,pendingTransitions:[],
  conversation:{...result.conversation,memories:[],forgotten:[],transitions:[],audit:{...result.conversation.audit,voiceSafety:'explicit-confirmation'} as typeof result.conversation.audit},
 };

 if(!hasDraft&&pendingTransitions.length===1&&pendingTransitions[0].state==='dismissed'&&priorWithdrawal.length===1&&priorWithdrawal[0].id===pendingTransitions[0].id&&explicitVoiceWithdrawal(text)&&namesThePriorWithdrawal(text,priorWithdrawalSummary)){
  return {...result,reply:'已按你再次确认的决定撤回这份待确认方案，已保存的项目和日程没有因此改变。',execution:{mode:'preview',quote:''},pendingTransitions,
   conversation:{...result.conversation,memories:[],forgotten:[],audit:{...result.conversation.audit,voiceSafety:'withdrawal-confirmed'} as typeof result.conversation.audit}};
 }
 // The model can omit planUpdates on a short second answer. The previous
 // receipt, not the model, binds "this plan" to one exact pending proposal.
 if(!hasDraft&&!pendingTransitions.length&&priorWithdrawal.length===1&&priorWithdrawal[0].state==='dismissed'&&explicitVoiceWithdrawal(text)&&namesThePriorWithdrawal(text,priorWithdrawalSummary)){
  return {...result,reply:'已按你再次确认的决定撤回这份待确认方案，已保存的项目和日程没有因此改变。',execution:{mode:'preview',quote:''},pendingTransitions:priorWithdrawal,
   conversation:{...result.conversation,memories:[],forgotten:[],transitions:priorWithdrawal,audit:{...result.conversation.audit,voiceSafety:'withdrawal-confirmed'} as typeof result.conversation.audit}};
 }

 const memoryOnly=!hasDraft&&!pendingTransitions.length&&!isConfirmation&&hasMemoryEffects;
 const conversation={...result.conversation,transitions:[],
  memories:hasDraft||memoryOnly?result.conversation.memories:[],
  forgotten:hasDraft||memoryOnly?result.conversation.forgotten:[],
  audit:{...result.conversation.audit,voiceSafety:pendingTransitions.length&&!hasDraft?'withdrawal-awaiting-confirmation':memoryOnly?'memory-only':'awaiting-confirmation',pendingVoiceTransitions:hasDraft?stagedTransitions:pendingTransitions} as typeof result.conversation.audit,
 };
 const execution={mode:'preview' as const,quote:''};
 if(hasDraft){
  const information=!pendingTransitions.length&&!hasMemoryEffects?result.information.trim():'';
  const targetName=result.draft!.summary.match(/「([^」]+)」/)?.[1];
  const confirmation=targetName?'确认保存'+targetName:'确认保存这份方案';
  const reply=[information,
   '我听到的安排是：'+result.draft!.summary+'。这份安排还没有保存，请核对后说“'+confirmation+'”；如果有同名方案，请按待确认列表中的顺序说“确认保存第几份方案”。需要更正直接告诉我。',
   pendingTransitions.length?'原来的待确认方案也会在你确认这份更正后才被替换。':'',
  ].filter(Boolean).join('\n\n');
  return {...result,reply,execution,conversation,pendingTransitions:stagedTransitions};
 }
 if(pendingTransitions.length){
  const reply='我听到你想撤回待确认的安排，但这段语音还没有改变原方案。若确定要撤回，请再次说“确认撤回这份方案”并说出事项名称；也可以在待确认方案中核对后撤回。';
  return {...result,reply,execution,conversation,pendingTransitions:[]};
 }
 if(hasMemoryEffects){
  return {...result,execution,conversation,pendingTransitions:[]};
 }
 if(isConfirmation){
  return {...result,reply:'这份方案还没有应用。为避免语音断句造成误操作，请核对后说“确认保存”；有修改也可以直接告诉我。',execution,conversation,pendingTransitions:[]};
 }
 if(result.execution.mode==='execute'){
  return {...result,reply:'我听到了，但还没有形成可核对的修改。请补充要改的事项，我会先复述，再由你确认保存。',execution,conversation,pendingTransitions:[]};
 }
 return {...result,execution,conversation,pendingTransitions:[]};
}
