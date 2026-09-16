import {z} from 'zod';
import {applyOperations,operationSchema,type Snapshot} from './domain.ts';
import {mergeChanges,type ChangeBaseline} from './changes.ts';
import {changeWarnings} from './planning.ts';

export const proposalSchema=z.object({summary:z.string().min(1).max(300),operations:z.array(operationSchema).min(1).max(30)});
export type Proposal=z.infer<typeof proposalSchema>;
export type Receipt={request_text:string;reply:string;proposal:string|null;work_revision:number;proposal_state?:string;base_records?:string|null};
export type Draft=Proposal&{id:string;revision:number;workRevision:number;requestText?:string;createdAt?:string;baseline?:ChangeBaseline;blocked?:string;warnings?:string[]};

export async function readChatReceipt(db:D1Database,user:string,requestId:string){
 return db.prepare('SELECT request_text,reply,proposal,work_revision,proposal_state,base_records FROM chat_receipts WHERE owner = ? AND request_id = ?').bind(user,requestId).first<Receipt>();
}
export function savedChat(snapshot:Snapshot,requestId:string,text:string,receipt:Receipt){
 if(receipt.request_text!==text)throw new Error('这次重试的内容已改变，请重新发送。');
 const parsed=proposalSchema.safeParse(receipt.proposal?JSON.parse(receipt.proposal):null);
 const alreadyApplied=snapshot.data.appliedIds.includes(requestId+'-apply')||receipt.proposal_state==='applied'||receipt.proposal_state==='dismissed';
 let baseline:ChangeBaseline|undefined,blocked:string|undefined,warnings:string[]=[];
 if(parsed.success&&!alreadyApplied){try{
  baseline=receipt.base_records?JSON.parse(receipt.base_records):undefined;
  if(!baseline&&receipt.work_revision!==snapshot.data.workRevision)blocked='旧方案未应用：这份早期方案缺少编辑基线，请按最新情况重新整理。';
  const operations=baseline?mergeChanges(snapshot.data,parsed.data.operations,baseline):parsed.data.operations;
  if(!blocked)warnings=changeWarnings(snapshot.data,operations).map(w=>w.message);
 }catch{blocked='方案涉及的内容已改变，请按最新情况重新整理；原方案仍保留。';}}
 return {snapshot,reply:receipt.reply,draft:parsed.success&&!alreadyApplied?{...parsed.data,revision:snapshot.revision,workRevision:receipt.work_revision,id:requestId+'-apply',baseline,blocked,warnings}:null,notice:blocked};
}

export async function pendingProposals(db:D1Database,user:string,snapshot:Snapshot,cursor?:{at:string;id:string}){
 const query='SELECT request_id,request_text,reply,proposal,work_revision,proposal_state,base_records,created_at FROM chat_receipts WHERE owner = ? AND proposal_state = ? AND proposal IS NOT NULL'+(cursor?' AND (created_at < ? OR (created_at = ? AND request_id < ?))':'')+' ORDER BY created_at DESC,request_id DESC LIMIT 21';
 const rows=(await db.prepare(query).bind(user,'pending',...(cursor?[cursor.at,cursor.at,cursor.id]:[])).all<Receipt&{request_id:string;created_at:string}>()).results;
 const page=rows.slice(0,20),last=page.at(-1);
 const drafts=page.flatMap(r=>{const result=savedChat(snapshot,r.request_id,r.request_text,r);return result.draft?[{...result.draft,requestText:r.request_text,createdAt:r.created_at}]:[]});
 return {drafts,nextCursor:rows.length>20&&last?{at:last.created_at,id:last.request_id}:null};
}

export async function commitWorkspace(db:D1Database,user:string,current:Snapshot,data:Snapshot['data'],operationId:string){
 const applying=operationId.endsWith('-apply');
 const condition=applying?" AND EXISTS (SELECT 1 FROM chat_receipts WHERE owner = ? AND request_id = ? AND proposal_state = 'pending' AND proposal IS NOT NULL)":'';
 const statements=[db.prepare('UPDATE workspaces SET payload = ?, revision = revision + 1, updated_at = ? WHERE owner = ? AND revision = ?'+condition).bind(JSON.stringify(data),new Date().toISOString(),user,current.revision,...(applying?[user,operationId.slice(0,-6)]:[]))];
 if(operationId.endsWith('-apply'))statements.push(db.prepare("UPDATE chat_receipts SET proposal_state = 'applied' WHERE owner = ? AND request_id = ? AND EXISTS (SELECT 1 FROM workspaces,json_each(workspaces.payload,'$.appliedIds') WHERE workspaces.owner = ? AND json_each.value = ?)").bind(user,operationId.slice(0,-6),user,operationId));
 const results=await db.batch(statements);return results[0].meta.changes===1;
}

// Both statements run in one transaction. A unique token prevents a losing retry
// from updating the workspace using another request's already-saved receipt.
export async function commitChat(db:D1Database,user:string,current:Snapshot,requestId:string,text:string,reply:string,draft:Proposal|null,workRevision:number,baseline?:ChangeBaseline){
 const at=new Date().toISOString(),commitToken=crypto.randomUUID();
 const data=applyOperations(current.data,[{type:'message.add',data:{id:requestId+'-u',role:'user',content:text,at}},{type:'message.add',data:{id:requestId+'-a',role:'assistant',content:reply,at}}],requestId);
 const results=await db.batch([
  db.prepare('INSERT OR IGNORE INTO chat_receipts (owner,request_id,request_text,reply,proposal,work_revision,commit_token,created_at,base_records) SELECT ?,?,?,?,?,?,?,?,? FROM workspaces WHERE owner = ? AND revision = ?').bind(user,requestId,text,reply,draft?JSON.stringify(draft):null,workRevision,commitToken,at,baseline?JSON.stringify(baseline):null,user,current.revision),
  db.prepare('UPDATE workspaces SET payload = ?, revision = revision + 1, updated_at = ? WHERE owner = ? AND revision = ? AND EXISTS (SELECT 1 FROM chat_receipts WHERE owner = ? AND request_id = ? AND commit_token = ?)').bind(JSON.stringify(data),at,user,current.revision,user,requestId,commitToken)
 ]);
 if(results[0].meta.changes!==results[1].meta.changes)throw new Error('回复保存状态暂时无法确认，请重试以读取已保存结果。');
 return results[0].meta.changes===1?{data,revision:current.revision+1}:null;
}
