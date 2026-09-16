import {type Data,type Snapshot} from './domain.ts';
import {commitHeader,commitGuard,recordStatements,operationEffects} from './workspace-storage.ts';
import {transitionsForWrite,transitionStatements} from './proposal-lifecycle.ts';
import {reconcileMemoryStatements} from './conversation-memory.ts';
export async function readRestore(db:D1Database,owner:string,requestId:string){return db.prepare('SELECT fingerprint FROM restore_receipts WHERE owner = ? AND request_id = ?').bind(owner,requestId).first<{fingerprint:string}>();}
export async function commitRestore(db:D1Database,owner:string,current:Snapshot,data:Data,requestId:string,fingerprint:string){
 const token=crypto.randomUUID(),at=new Date().toISOString();
 const transitions=await transitionsForWrite(db,owner,current.data,data,operationEffects(current.data,data));
 const results=await db.batch([
  commitHeader(db,owner,current,data,token,' AND NOT EXISTS (SELECT 1 FROM restore_receipts WHERE owner=? AND request_id=?)',[owner,requestId]),
  ...recordStatements(db,owner,token,current.data,data),
  ...transitionStatements(db,owner,token,transitions),
  ...reconcileMemoryStatements(db,owner,token),
  db.prepare(`INSERT INTO restore_receipts(owner,request_id,fingerprint,commit_token,created_at) SELECT ?,?,?,?,? WHERE ${commitGuard}`).bind(owner,requestId,fingerprint,token,at,owner,token)
 ]);
 return results[0].meta.changes===1;
}
