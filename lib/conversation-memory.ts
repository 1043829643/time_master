import {z} from 'zod';
import {applyOperations,localDay,type Data,type Operation} from './domain.ts';
import {commitGuard,jsonChunks} from './workspace-storage.ts';

const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z');return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===v},'日期无效');
export const memoryInputSchema=z.object({
 id:z.string().max(100).optional(),
 kind:z.enum(['preference','constraint','context','open_request']),
 statement:z.string().min(1).max(800),quote:z.string().min(1).max(1000),
 certainty:z.enum(['confirmed','tentative']),
 date:day.nullable().default(null),subjectId:z.string().max(100).default(''),
 rule:z.enum(['not_before','travel_before','none']).default('none'),
 time:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().default(null),
 minutes:z.number().int().min(0).max(1440).nullable().default(null),
});
export type MemoryInput=z.infer<typeof memoryInputSchema>;
export type ConversationMemory=MemoryInput&{id:string;sourceRequestId:string;createdAt:string;proposedBy?:string;supersedes?:string;stagedDeletion?:boolean};
export function stageMemories(memories:ConversationMemory[],requestId:string,forgotten:string[]=[],known:ConversationMemory[]=[]){return [...memories,...known.filter(m=>forgotten.includes(m.id)).map(m=>({...m,stagedDeletion:true}))].map((m,i)=>({...m,id:requestId+'-staged-'+i,proposedBy:requestId,supersedes:m.id}));}
export async function memoriesForProposal(db:D1Database,owner:string,known:ConversationMemory[],id:string){const rows=await db.prepare("SELECT payload FROM conversation_memories WHERE owner=? AND state='staged' AND json_extract(payload,'$.proposedBy')=?").bind(owner,id).all<{payload:string}>();const staged=rows.results.map(r=>JSON.parse(r.payload) as ConversationMemory);return mergeMemories(known,staged.filter(m=>!m.stagedDeletion),staged.map(m=>m.supersedes||''));}
export async function readMemories(db:D1Database,owner:string,today:string){
 const rows=await db.prepare("SELECT payload FROM conversation_memories WHERE owner=? AND state='active' ORDER BY updated_at,id").bind(owner).all<{payload:string}>();
 return rows.results.map(r=>JSON.parse(r.payload) as ConversationMemory).filter(m=>!m.date||m.date>=today);
}
export function prepareMemories(inputs:MemoryInput[],known:ConversationMemory[],text:string,requestId:string,data:Data):ConversationMemory[]{
 const subjects=new Set(['',...data.projects.map(v=>v.id),...data.tasks.map(v=>v.id),...data.blocks.map(v=>v.id),...data.contacts.map(v=>v.id)]);
 return inputs.map((m,i)=>{
  if(!text.includes(m.quote))throw new Error('记忆必须引用本轮用户原话，不能用助手推断作证据。');
  if(m.id&&!known.some(v=>v.id===m.id))throw new Error('要更新的记忆不在当前上下文中。');
  if(!subjects.has(m.subjectId))throw new Error('记忆引用了不存在的对象。');
  // A model may generalize one scheduling choice into an enduring habit. Only
  // explicit recurring language can establish an unscoped, free-form preference.
  // Preserve weaker evidence verbatim as today's context, not a future policy.
  if(m.kind==='preference'&&m.rule==='none'&&!m.subjectId&&!m.date&&!/(?:一般|平时|通常|习惯|以后|今后|一直|长期|经常|总是|每(?:天|周|月|次)|都要|都不|不喜欢|喜欢)/.test(m.quote))m={...m,kind:'context',statement:m.quote,date:localDay()};
  if(m.rule==='not_before'&&!m.time)throw new Error('最早开始约束缺少时间。');
  if(m.rule==='travel_before'&&(!m.minutes||!data.blocks.some(b=>b.id===m.subjectId)))throw new Error('路程约束必须关联已知日程并提供分钟数。');
  const sameScope=(v:ConversationMemory)=>v.rule===m.rule&&v.subjectId===m.subjectId&&v.date===m.date;
  const explicit=known.find(v=>v.id===m.id),matching=m.rule!=='none'?known.find(v=>sameScope(v)):undefined;
  // A one-day exception must never overwrite the standing preference. Repeated
  // updates to the same typed constraint reuse its server-owned identity.
  const existing=explicit&&(sameScope(explicit)||!!m.subjectId&&explicit.subjectId===m.subjectId&&explicit.rule===m.rule)?explicit:matching;
  if(m.rule==='none')m={...m,statement:m.quote};
  return {...m,id:existing?.id||requestId+'-memory-'+i,sourceRequestId:requestId,createdAt:new Date().toISOString()};
 });
}
export function mergeMemories(known:ConversationMemory[],updates:ConversationMemory[],forgotten:string[]=[]){
 const values=new Map(known.filter(m=>!forgotten.includes(m.id)).map(m=>[m.id,m]));
 for(const value of updates)values.set(value.id,value);
 return [...values.values()];
}
export function memoryStatements(db:D1Database,owner:string,token:string,updates:ConversationMemory[],forgotten:string[]=[]){
 return [
  ...jsonChunks(updates).map(chunk=>db.prepare(`INSERT INTO conversation_memories(owner,id,payload,state,updated_at)
   SELECT ?,json_extract(value,'$.id'),value,CASE WHEN json_extract(value,'$.proposedBy') IS NULL THEN 'active' ELSE 'staged' END,? FROM json_each(?) WHERE ${commitGuard}
   ON CONFLICT(owner,id) DO UPDATE SET payload=excluded.payload,state=excluded.state,updated_at=excluded.updated_at`).bind(owner,new Date().toISOString(),chunk,owner,token)),
  ...jsonChunks(forgotten).map(chunk=>db.prepare(`UPDATE conversation_memories SET state='forgotten',updated_at=? WHERE owner=? AND id IN (SELECT value FROM json_each(?)) AND ${commitGuard}`).bind(new Date().toISOString(),owner,chunk,owner,token)),
 ];
}
export function reconcileMemoryStatements(db:D1Database,owner:string,token:string){return [
 db.prepare(`UPDATE conversation_memories SET state='superseded' WHERE owner=? AND state='active' AND id IN (SELECT json_extract(m.payload,'$.supersedes') FROM conversation_memories m JOIN chat_receipts c ON c.owner=m.owner AND c.request_id=json_extract(m.payload,'$.proposedBy') WHERE m.owner=? AND m.state='staged' AND c.proposal_state IN ('applied','satisfied')) AND ${commitGuard}`).bind(owner,owner,owner,token),
 db.prepare(`UPDATE conversation_memories SET state=CASE WHEN COALESCE(json_extract(payload,'$.stagedDeletion'),0)=0 AND EXISTS(SELECT 1 FROM chat_receipts c WHERE c.owner=? AND c.request_id=json_extract(conversation_memories.payload,'$.proposedBy') AND c.proposal_state IN ('applied','satisfied')) THEN 'active' ELSE 'forgotten' END WHERE owner=? AND state='staged' AND EXISTS(SELECT 1 FROM chat_receipts c WHERE c.owner=? AND c.request_id=json_extract(conversation_memories.payload,'$.proposedBy') AND c.proposal_state<>'pending') AND ${commitGuard}`).bind(owner,owner,owner,owner,token),
 db.prepare(`UPDATE conversation_memories SET state='forgotten' WHERE owner=? AND state='active' AND json_extract(payload,'$.subjectId')<>'' AND NOT EXISTS(SELECT 1 FROM workspace_records r WHERE r.owner=? AND r.id=json_extract(conversation_memories.payload,'$.subjectId') AND r.kind IN ('projects','tasks','blocks','contacts')) AND ${commitGuard}`).bind(owner,owner,owner,token)
 ];}
const minute=(s:string)=>Number(s.slice(0,2))*60+Number(s.slice(3,5));
export function constraintViolations(data:Data,ops:Operation[],memories:ConversationMemory[]){
 const problems:string[]=[];
 const after=ops.length?applyOperations(data,ops,'constraint-preview'):data;
 const changed=new Set(ops.filter(o=>o.type==='block.save').map(o=>(o.data as any)?.id));
 const travelTargetChanged=memories.some(m=>m.rule==='travel_before'&&changed.has(m.subjectId));
 for(const block of after.blocks){
  if(!changed.has(block.id)&&!travelTargetChanged)continue;
  const original=data.blocks.find(b=>b.id===block.id);
  if(!block.start||block.done)continue;
  const date=block.start.slice(0,10),task=after.tasks.find(t=>t.id===block.taskId);
  const deadline=task?.deadlineAt||(task?.deadline?task.deadline+'T23:59':'');if(changed.has(block.id)&&deadline&&block.end>deadline)problems.push(`「${block.name}」超出硬截止 ${deadline.replace('T',' ')}。`);
  for(const m of memories){
   if(m.certainty!=='confirmed'||m.date&&m.date!==date)continue;
   if(!m.date&&memories.some(exception=>exception.certainty==='confirmed'&&exception.date===date&&exception.rule===m.rule&&exception.subjectId===m.subjectId))continue;
   if(m.rule==='not_before'&&m.time&&changed.has(block.id)&&!(original?.fixed&&original.start===block.start&&original.end===block.end)){
    const applies=m.subjectId?m.subjectId===block.id||m.subjectId===block.taskId||m.subjectId===task?.projectId||m.subjectId===task?.contactId||m.subjectId===block.contactId:true;
    if(applies&&minute(block.start.slice(11))<minute(m.time))problems.push(`「${block.name}」早于已确认的最早开始时间 ${m.time}：${m.statement}`);
   }
   if(m.rule==='travel_before'&&m.minutes){
    const target=after.blocks.find(b=>b.id===m.subjectId);
    if(target&&target.id!==block.id&&target.start.slice(0,10)===date&&block.start<target.start){
     const gap=(Date.parse(target.start+'+08:00')-Date.parse(block.end+'+08:00'))/60000;
     if(gap<m.minutes)problems.push(`「${block.name}」结束后到「${target.name}」仅有 ${Math.max(0,gap)} 分钟，已说明路程需要 ${m.minutes} 分钟。`);
    }
   }
  }
 }
 return [...new Set(problems)];
}
