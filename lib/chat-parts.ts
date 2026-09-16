import {jsonChunks,commitGuard} from './workspace-storage.ts';
import {type ChangeBaseline} from './changes.ts';
import {type Proposal,type Receipt} from './chat-state.ts';

// Legacy receipts remain readable. New proposals and edit baselines are stored
// one operation/record per row, so a large plan cannot exceed a D1 row limit.
export async function hydrateReceipts<T extends Receipt&{request_id:string;payload_version?:number}>(db:D1Database,owner:string,rows:T[]):Promise<T[]>{
 const ids=rows.filter(r=>r.payload_version===1&&r.proposal).map(r=>r.request_id);if(!ids.length)return rows;
 const parts=(await db.prepare('SELECT request_id,kind,position,payload FROM chat_parts WHERE owner=? AND request_id IN (SELECT value FROM json_each(?)) ORDER BY request_id,kind,position').bind(owner,JSON.stringify(ids)).all<{request_id:string;kind:string;position:number;payload:string}>()).results;
 const grouped=new Map<string,typeof parts>();for(const part of parts){const group=grouped.get(part.request_id)||[];group.push(part);grouped.set(part.request_id,group);}
 return rows.map(r=>{if(r.payload_version!==1||!r.proposal)return r;const p=grouped.get(r.request_id)||[],values=(kind:string)=>p.filter(v=>v.kind===kind).map(v=>JSON.parse(v.payload));return {...r,proposal:JSON.stringify({...JSON.parse(r.proposal),operations:values('operation')}),base_records:r.base_records?JSON.stringify({records:values('baseline'),deletions:Object.fromEntries(values('deletion'))}):null};});
}
export function chatPartStatements(db:D1Database,owner:string,requestId:string,token:string,draft:Proposal|null,baseline?:ChangeBaseline){
 const parts=[...(draft?.operations||[]).map((payload,position)=>({kind:'operation',position,payload})),...(baseline?.records||[]).map((payload,position)=>({kind:'baseline',position,payload})),...Object.entries(baseline?.deletions||{}).map((payload,position)=>({kind:'deletion',position,payload}))];
 return jsonChunks(parts).map(chunk=>db.prepare(`INSERT INTO chat_parts(owner,request_id,kind,position,payload) SELECT ?,?,json_extract(value,'$.kind'),json_extract(value,'$.position'),json_extract(value,'$.payload') FROM json_each(?) WHERE ${commitGuard}`).bind(owner,requestId,chunk,owner,token));
}
