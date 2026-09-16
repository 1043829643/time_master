import {type Data,type Snapshot} from './domain.ts';
export async function readRestore(db:D1Database,owner:string,requestId:string){return db.prepare('SELECT fingerprint FROM restore_receipts WHERE owner = ? AND request_id = ?').bind(owner,requestId).first<{fingerprint:string}>();}
export async function commitRestore(db:D1Database,owner:string,current:Snapshot,data:Data,requestId:string,fingerprint:string){
 const token=crypto.randomUUID(),at=new Date().toISOString();
 const results=await db.batch([
  db.prepare('INSERT OR IGNORE INTO restore_receipts (owner,request_id,fingerprint,commit_token,created_at) SELECT ?,?,?,?,? FROM workspaces WHERE owner = ? AND revision = ?').bind(owner,requestId,fingerprint,token,at,owner,current.revision),
  db.prepare('UPDATE workspaces SET payload = ?, revision = revision + 1, updated_at = ? WHERE owner = ? AND revision = ? AND EXISTS (SELECT 1 FROM restore_receipts WHERE owner = ? AND request_id = ? AND commit_token = ?)').bind(JSON.stringify(data),at,owner,current.revision,owner,requestId,token)
 ]);
 if(results[0].meta.changes!==results[1].meta.changes)throw new Error('恢复状态暂时无法确认，请重试读取结果。');
 return results[0].meta.changes===1;
}
