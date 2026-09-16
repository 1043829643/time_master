import {z} from 'zod';
import {applyOperations,operationSchema,type Snapshot} from './domain.ts';
import {mergeChanges,type ChangeBaseline} from './changes.ts';
import {changeWarnings} from './planning.ts';
import {pendingPlanWarnings,type ReviewablePlan} from './proposal-review.ts';
import {commitHeader,commitGuard,recordStatements,commitRecords,workspaceRevision} from './workspace-storage.ts';
import {hydrateReceipts,chatPartStatements} from './chat-parts.ts';
import {targetStatements,transitionStatements,type PlanTransition} from './proposal-lifecycle.ts';
import {memoryStatements,type ConversationMemory} from './conversation-memory.ts';

export const proposalSchema=z.object({summary:z.string().min(1).max(300),operations:z.array(operationSchema).min(1).max(30)});
export type Proposal=z.infer<typeof proposalSchema>;
export type Receipt={request_text:string;reply:string;proposal:string|null;work_revision:number;proposal_state?:string;base_records?:string|null;protocol_version?:number;state_reason?:string|null;superseded_by?:string|null};
export type Draft=Proposal&{id:string;revision:number;workRevision:number;requestText?:string;createdAt?:string;baseline?:ChangeBaseline;blocked?:string;warnings?:string[];pendingWarnings?:string[]};

export async function readChatReceipt(db:D1Database,user:string,requestId:string){
 const row=await db.prepare('SELECT request_id,request_text,reply,proposal,work_revision,proposal_state,base_records,payload_version,protocol_version,state_reason,superseded_by FROM chat_receipts WHERE owner = ? AND request_id = ?').bind(user,requestId).first<Receipt&{request_id:string;payload_version:number}>();
 return row?(await hydrateReceipts(db,user,[row]))[0]:null;
}
export function savedChat(snapshot:Snapshot,requestId:string,text:string,receipt:Receipt){
 if(receipt.request_text!==text)throw new Error('这次重试的内容已改变，请重新发送。');
 const parsed=proposalSchema.safeParse(receipt.proposal?JSON.parse(receipt.proposal):null);
 const alreadyApplied=snapshot.data.appliedIds.includes(requestId+'-apply')||!!receipt.proposal_state&&receipt.proposal_state!=='pending';
 let baseline:ChangeBaseline|undefined,blocked:string|undefined,warnings:string[]=[];
 if(parsed.success&&!alreadyApplied){try{
  baseline=receipt.base_records?JSON.parse(receipt.base_records):undefined;
  if(receipt.protocol_version===0)blocked='这份方案来自升级前，请按当前安排重新整理，避免沿用已经改变的决定。';
  if(!baseline&&receipt.work_revision!==snapshot.data.workRevision)blocked='旧方案未应用：这份早期方案缺少编辑基线，请按最新情况重新整理。';
  const operations=baseline?mergeChanges(snapshot.data,parsed.data.operations,baseline):parsed.data.operations;
  if(!blocked)warnings=changeWarnings(snapshot.data,operations).map(w=>w.message);
 }catch{blocked='方案涉及的内容已改变，请按最新情况重新整理；原方案仍保留。';}}
 return {snapshot,reply:receipt.reply,draft:parsed.success&&!alreadyApplied?{...parsed.data,revision:snapshot.revision,workRevision:receipt.work_revision,id:requestId+'-apply',baseline,blocked,warnings}:null,notice:blocked};
}

export async function pendingProposals(db:D1Database,user:string,snapshot:Snapshot,cursor?:{at:string;id:string}){
 const query='SELECT request_id,request_text,reply,proposal,work_revision,proposal_state,base_records,created_at,payload_version,protocol_version,state_reason,superseded_by FROM chat_receipts WHERE owner = ? AND proposal_state = ? AND proposal IS NOT NULL'+(cursor?' AND (created_at < ? OR (created_at = ? AND request_id < ?))':'')+' ORDER BY created_at DESC,request_id DESC LIMIT 21';
 const rows=(await db.prepare(query).bind(user,'pending',...(cursor?[cursor.at,cursor.at,cursor.id]:[])).all<Receipt&{request_id:string;created_at:string}>()).results;
 const page=await hydrateReceipts(db,user,rows.slice(0,20)),last=page.at(-1);
 const drafts=page.flatMap(r=>{const result=savedChat(snapshot,r.request_id,r.request_text,r);return result.draft?[{...result.draft,requestText:r.request_text,createdAt:r.created_at}]:[]});
 const all=await allPendingPlans(db,user),warnings=pendingPlanWarnings(snapshot.data,all,new Set(drafts.map(d=>d.id)));
 return {drafts:drafts.map(d=>({...d,pendingWarnings:warnings[d.id]||[]})),nextCursor:rows.length>20&&last?{at:last.created_at,id:last.request_id}:null};
}

export async function allPendingPlans(db:D1Database,user:string):Promise<ReviewablePlan[]>{
 const rows=await hydrateReceipts(db,user,(await db.prepare("SELECT request_id,request_text,reply,proposal,base_records,work_revision,payload_version,protocol_version FROM chat_receipts WHERE owner = ? AND proposal_state = 'pending' AND proposal IS NOT NULL ORDER BY created_at DESC,request_id DESC").bind(user).all<Receipt&{request_id:string}>()).results);
 return rows.flatMap(row=>{try{const plan=proposalSchema.parse(JSON.parse(row.proposal!));return [{...plan,id:row.request_id+'-apply',requestText:row.request_text,protocolVersion:row.protocol_version,baseline:row.base_records?JSON.parse(row.base_records):undefined,workRevision:row.work_revision}]}catch{return []}});
}
export type ChatCursor={at:string;id:string};
export async function chatHistory(db:D1Database,user:string,cursor?:ChatCursor){
 const watermark=Math.max(0,await workspaceRevision(db,user));
 const rows=(await db.prepare('SELECT request_id,request_text,reply,created_at FROM chat_receipts WHERE owner = ? AND sequence <= ?'+(cursor?' AND (created_at < ? OR (created_at = ? AND request_id < ?))':'')+' ORDER BY created_at DESC,request_id DESC LIMIT 41').bind(user,watermark,...(cursor?[cursor.at,cursor.at,cursor.id]:[])).all<{request_id:string;request_text:string;reply:string;created_at:string}>()).results;
 const page=rows.slice(0,40),last=page.at(-1);
 const messages=page.reverse().flatMap(r=>[{id:r.request_id+'-u',role:'user' as const,content:r.request_text,at:r.created_at},{id:r.request_id+'-a',role:'assistant' as const,content:r.reply,at:r.created_at}]);
 return {messages,nextCursor:rows.length>40&&last?{at:last.created_at,id:last.request_id}:null,watermark};
}

export async function chatUpdates(db:D1Database,user:string,after:number,until?:number){
 const watermark=Math.min(until??Number.MAX_SAFE_INTEGER,Math.max(0,await workspaceRevision(db,user)));
 const rows=(await db.prepare('SELECT request_id,request_text,reply,created_at,sequence FROM chat_receipts WHERE owner=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT 41').bind(user,after,watermark).all<{request_id:string;request_text:string;reply:string;created_at:string;sequence:number}>()).results;
 const page=rows.slice(0,40),hasMore=rows.length>40;
 return {messages:page.flatMap(r=>[{id:r.request_id+'-u',role:'user' as const,content:r.request_text,at:r.created_at},{id:r.request_id+'-a',role:'assistant' as const,content:r.reply,at:r.created_at}]),nextAfter:hasMore?page.at(-1)!.sequence:watermark,hasMore,watermark};
}

export async function commitWorkspace(db:D1Database,user:string,current:Snapshot,data:Snapshot['data'],operationId:string,hash=''){
 return commitRecords(db,user,current,data,operationId,hash);
}

// Both statements run in one transaction. A unique token prevents a losing retry
// from updating the workspace using another request's already-saved receipt.
export type ConversationCommit={memories?:ConversationMemory[];forgotten?:string[];transitions?:PlanTransition[];audit?:unknown};
export async function commitChat(db:D1Database,user:string,current:Snapshot,requestId:string,text:string,reply:string,draft:Proposal|null,workRevision:number,baseline?:ChangeBaseline,conversation:ConversationCommit={}){
 const at=new Date().toISOString(),commitToken=crypto.randomUUID();
 const data=applyOperations(current.data,[{type:'message.add',data:{id:requestId+'-u',role:'user',content:text,at}},{type:'message.add',data:{id:requestId+'-a',role:'assistant',content:reply,at}}],requestId);
 const results=await db.batch([
  commitHeader(db,user,current,data,commitToken,' AND NOT EXISTS (SELECT 1 FROM chat_receipts WHERE owner=? AND request_id=?)',[user,requestId]),
  ...recordStatements(db,user,commitToken,current.data,data),
  db.prepare(`INSERT INTO chat_receipts (owner,request_id,request_text,reply,proposal,work_revision,commit_token,created_at,base_records,sequence,payload_version,protocol_version,turn_context) SELECT ?,?,?,?,?,?,?,?,?,?,1,2,? WHERE ${commitGuard}`).bind(user,requestId,text,reply,draft?JSON.stringify({summary:draft.summary}):null,workRevision,commitToken,at,baseline?'parts':null,current.revision+1,conversation.audit?JSON.stringify(conversation.audit):null,user,commitToken),
  ...chatPartStatements(db,user,requestId,commitToken,draft,baseline),
  ...targetStatements(db,user,requestId,commitToken,draft?.operations||[]),
  ...transitionStatements(db,user,commitToken,conversation.transitions||[]),
  ...memoryStatements(db,user,commitToken,conversation.memories||[],conversation.forgotten||[]),
 ]);
 return results[0].meta.changes===1?{data,revision:current.revision+1}:null;
}

export async function dismissProposal(db:D1Database,user:string,current:Snapshot,requestId:string){
 const token=crypto.randomUUID();const result=await db.batch([
  commitHeader(db,user,current,current.data,token," AND EXISTS (SELECT 1 FROM chat_receipts WHERE owner=? AND request_id=? AND proposal_state='pending' AND proposal IS NOT NULL)",[user,requestId]),
  db.prepare(`UPDATE chat_receipts SET proposal_state='dismissed' WHERE owner=? AND request_id=? AND ${commitGuard}`).bind(user,requestId,user,token)
 ]);return result[0].meta.changes===1;
}
