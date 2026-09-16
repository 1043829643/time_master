import {applyOperations,type Data,type Operation} from './domain.ts';
import {mergeChanges,stable,type ChangeBaseline} from './changes.ts';
import {hydrateReceipts} from './chat-parts.ts';
import {commitGuard,jsonChunks} from './workspace-storage.ts';

export type PlanTransition={id:string;state:'superseded'|'dismissed'|'invalidated'|'satisfied';reason:string;replacementId?:string};
export const targetOf=(op:Operation)=>({kind:op.type.split('.')[0],id:op.id||String((op.data as any)?.id||'')});
export function effectiveOperations(data:Data,ops:Operation[]){
 return ops.filter(op=>{
  if(!op.type.endsWith('.save'))return true;
  const {kind,id}=targetOf(op),key=({project:'projects',task:'tasks',block:'blocks',contact:'contacts',resource:'resources'} as const)[kind as 'project'];
  const old=(data[key] as any[]|undefined)?.find(v=>v.id===id);
  if(!old)return true;
  const clean=(v:any)=>Object.fromEntries(Object.entries(v).filter(([k])=>k!=='updatedAt'));
  return stable(clean({...old,...op.data as any}))!==stable(clean(old));
 });
}
export function targetStatements(db:D1Database,owner:string,requestId:string,token:string,ops:Operation[]){
 const targets=[...new Map(ops.map(op=>{const t=targetOf(op);return [t.kind+':'+t.id,t]})).values()];
 return jsonChunks(targets).map(chunk=>db.prepare(`INSERT INTO proposal_targets(owner,request_id,kind,id)
  SELECT ?,?,json_extract(value,'$.kind'),json_extract(value,'$.id') FROM json_each(?) WHERE ${commitGuard}`).bind(owner,requestId,chunk,owner,token));
}
export function transitionStatements(db:D1Database,owner:string,token:string,transitions:PlanTransition[]){
 return jsonChunks(transitions).map(chunk=>db.prepare(`UPDATE chat_receipts SET
  proposal_state=(SELECT json_extract(value,'$.state') FROM json_each(?) WHERE json_extract(value,'$.id')=chat_receipts.request_id),
  state_reason=(SELECT json_extract(value,'$.reason') FROM json_each(?) WHERE json_extract(value,'$.id')=chat_receipts.request_id),
  superseded_by=(SELECT json_extract(value,'$.replacementId') FROM json_each(?) WHERE json_extract(value,'$.id')=chat_receipts.request_id)
  WHERE owner=? AND proposal_state='pending' AND request_id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${commitGuard}`).bind(chunk,chunk,chunk,owner,chunk,owner,token));
}
// Terminal status is persisted in the same business transaction, so a deleted
// record cannot later make an old "create" proposal valid again (the ABA case).
export async function transitionsForWrite(db:D1Database,owner:string,before:Data,after:Data,effects:{kind:string;id:string}[],applying?:string){
 if(!effects.length)return [];
 const rows=await db.prepare(`SELECT c.request_id,c.request_text,c.reply,c.proposal,c.base_records,c.work_revision,c.payload_version,c.protocol_version
  FROM chat_receipts c WHERE c.owner=? AND c.proposal_state='pending' AND c.proposal IS NOT NULL`).bind(owner).all<any>();
 const plans=await hydrateReceipts(db,owner,rows.results),result:PlanTransition[]=[];
 for(const p of plans){
  if(p.request_id===applying)continue;
  if(p.protocol_version<2){result.push({id:p.request_id,state:'invalidated',reason:'早期方案需要按最新安排重新整理。'});continue;}
  try{
   const ops=JSON.parse(p.proposal).operations as Operation[],baseline=p.base_records?JSON.parse(p.base_records) as ChangeBaseline:undefined;
   if(!baseline)throw new Error('missing baseline');
   mergeChanges(before,ops,baseline);
   if(!effectiveOperations(after,ops).length){result.push({id:p.request_id,state:'satisfied',reason:'这些变更已体现在当前安排中。'});continue;}
   const merged=mergeChanges(after,ops,baseline);
   if(merged.length)applyOperations(after,merged,'validate-plan');
   if(!effectiveOperations(after,merged).length)result.push({id:p.request_id,state:'satisfied',reason:'这些变更已体现在当前安排中。'});
  }catch{result.push({id:p.request_id,state:'invalidated',reason:'相关记录已有新决定，这份旧方案不能继续应用。'});}
 }
 return result;
}
