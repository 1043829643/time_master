import {fingerprint} from './fingerprint.ts';
import {commitGuard} from './workspace-storage.ts';

export type ChatRequest={request_id:string;request_text:string;state:'received'|'processing'|'failed'|'completed'|'cancelled';error:string|null;created_at:string;lease_until:number};
export class RequestBusy extends Error {constructor(){super('正在处理上一条内容，这条已经收到，会保留并继续处理。');}}
export class RequestClosed extends Error {constructor(){super('这条请求已取消，原话仍保留。需要重新执行时请重新发送。');}}

/** Reception is durable before any provider call. No business state is implied. */
export async function receiveChatRequest(db:D1Database,owner:string,id:string,text:string){
 const now=new Date().toISOString(),hash=fingerprint(text);
 await db.prepare('INSERT OR IGNORE INTO chat_requests(owner,request_id,request_text,fingerprint,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').bind(owner,id,text,hash,'received',now,now).run();
 const row=await db.prepare('SELECT fingerprint,state FROM chat_requests WHERE owner=? AND request_id=?').bind(owner,id).first<{fingerprint:string;state:string}>();
 if(!row||row.fingerprint!==hash)throw new Error('同一请求的内容已改变，请作为新消息发送。');
 if(row.state==='cancelled')throw new RequestClosed();
}
export async function claimChatRequest(db:D1Database,owner:string,id:string,now=Date.now()){
 const token=crypto.randomUUID();
 const r=await db.prepare(`UPDATE chat_requests SET state='processing',lease_token=?,lease_until=?,error=NULL,updated_at=?
  WHERE owner=? AND request_id=? AND (state IN ('received','failed') OR (state='processing' AND lease_until<=?))
  AND NOT EXISTS(SELECT 1 FROM chat_requests other WHERE other.owner=? AND other.request_id<>? AND other.state='processing' AND other.lease_until>?)`).bind(token,now+90000,new Date(now).toISOString(),owner,id,now,owner,id,now).run();
 if(r.meta.changes!==1)throw new RequestBusy();return token;
}
export async function failChatRequest(db:D1Database,owner:string,id:string,lease:string,error:string){
 await db.prepare("UPDATE chat_requests SET state='failed',error=?,lease_until=0,updated_at=? WHERE owner=? AND request_id=? AND state='processing' AND lease_token=?").bind(error.slice(0,1000),new Date().toISOString(),owner,id,lease).run();
}
export function completeRequestStatements(db:D1Database,owner:string,id:string,token:string,lease:string){return [db.prepare(`UPDATE chat_requests SET state='completed',error=NULL,lease_until=0,updated_at=? WHERE owner=? AND request_id=? AND state='processing' AND lease_token=? AND ${commitGuard}`).bind(new Date().toISOString(),owner,id,lease,owner,token)];}
export async function recentRequests(db:D1Database,owner:string,limit=40){
 return (await db.prepare('SELECT request_id,request_text,state,error,created_at,lease_until FROM chat_requests WHERE owner=? ORDER BY rowid DESC LIMIT ?').bind(owner,limit).all<ChatRequest>()).results.reverse();
}
export async function cancelChatRequest(db:D1Database,owner:string,id:string){
 // This fence also prevents a provider response arriving after cancellation from committing.
 await db.prepare("UPDATE chat_requests SET state='cancelled',lease_until=0,updated_at=? WHERE owner=? AND request_id=? AND state<>'completed'").bind(new Date().toISOString(),owner,id).run();
 return db.prepare('SELECT request_id,request_text,state,error,created_at,lease_until FROM chat_requests WHERE owner=? AND request_id=?').bind(owner,id).first<ChatRequest>();
}
