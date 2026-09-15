import {z} from 'zod';
import {applyOperations,operationSchema,type Snapshot} from './domain.ts';

export const proposalSchema=z.object({summary:z.string().min(1).max(300),operations:z.array(operationSchema).min(1).max(30)});
export type Proposal=z.infer<typeof proposalSchema>;
export type Receipt={request_text:string;reply:string;proposal:string|null;work_revision:number};

export async function readChatReceipt(db:D1Database,user:string,requestId:string){
 return db.prepare('SELECT request_text,reply,proposal,work_revision FROM chat_receipts WHERE owner = ? AND request_id = ?').bind(user,requestId).first<Receipt>();
}
export function savedChat(snapshot:Snapshot,requestId:string,text:string,receipt:Receipt){
 if(receipt.request_text!==text)throw new Error('这次重试的内容已改变，请重新发送。');
 const parsed=proposalSchema.safeParse(receipt.proposal?JSON.parse(receipt.proposal):null);
 const alreadyApplied=snapshot.data.appliedIds.includes(requestId+'-apply');
 const stale=!!receipt.proposal&&receipt.work_revision!==snapshot.data.workRevision&&!alreadyApplied;
 return {snapshot,reply:receipt.reply,draft:parsed.success&&!alreadyApplied?{...parsed.data,revision:snapshot.revision,workRevision:receipt.work_revision,id:requestId+'-apply'}:null,notice:stale?'项目或日程已有更新，旧方案未应用。最新数据已同步，请让时间伙伴重新安排。':undefined};
}

// Both statements run in one transaction. A unique token prevents a losing retry
// from updating the workspace using another request's already-saved receipt.
export async function commitChat(db:D1Database,user:string,current:Snapshot,requestId:string,text:string,reply:string,draft:Proposal|null,workRevision:number){
 const at=new Date().toISOString(),commitToken=crypto.randomUUID();
 const data=applyOperations(current.data,[{type:'message.add',data:{id:requestId+'-u',role:'user',content:text,at}},{type:'message.add',data:{id:requestId+'-a',role:'assistant',content:reply,at}}],requestId);
 const results=await db.batch([
  db.prepare('INSERT OR IGNORE INTO chat_receipts (owner,request_id,request_text,reply,proposal,work_revision,commit_token,created_at) SELECT ?,?,?,?,?,?,?,? FROM workspaces WHERE owner = ? AND revision = ?').bind(user,requestId,text,reply,draft?JSON.stringify(draft):null,workRevision,commitToken,at,user,current.revision),
  db.prepare('UPDATE workspaces SET payload = ?, revision = revision + 1, updated_at = ? WHERE owner = ? AND revision = ? AND EXISTS (SELECT 1 FROM chat_receipts WHERE owner = ? AND request_id = ? AND commit_token = ?)').bind(JSON.stringify(data),at,user,current.revision,user,requestId,commitToken)
 ]);
 if(results[0].meta.changes!==results[1].meta.changes)throw new Error('回复保存状态暂时无法确认，请重试以读取已保存结果。');
 return results[0].meta.changes===1?{data,revision:current.revision+1}:null;
}