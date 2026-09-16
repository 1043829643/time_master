import {emptyData,validateData,type Data,type Snapshot} from './domain.ts';
import {kinds,records,type ChangeBaseline} from './changes.ts';
import {fingerprint} from './fingerprint.ts';

export const collections=['projects','tasks','blocks','contacts','resources','messages','history'] as const;
type StoredRecord={kind:string;id:string;payload:string;position:number};
const encoder=new TextEncoder();
export const metadata=(data:Data)=>JSON.stringify({workRevision:data.workRevision,appliedIds:data.appliedIds});
export function assembleWorkspace(payload:string,rows:StoredRecord[],revision:number):Snapshot {
 const data={...emptyData(),...JSON.parse(payload)};
 for(const key of collections)data[key]=rows.filter(r=>r.kind===key).sort((a,b)=>a.position-b.position).map(r=>JSON.parse(r.payload));
 return {data:validateData(data),revision};
}

// Existing workspaces migrate lazily in one transaction. On failure the original
// payload remains authoritative; another request can safely retry the migration.
export async function ensureWorkspace(db:D1Database,owner:string){
 await db.prepare('INSERT OR IGNORE INTO workspaces (owner,payload,revision,updated_at,storage_version) VALUES (?,?,0,?,1)').bind(owner,metadata(emptyData()),new Date().toISOString()).run();
 const state=await db.prepare('SELECT storage_version FROM workspaces WHERE owner=?').bind(owner).first<{storage_version:number}>();
 if(state?.storage_version===1)return;
 await db.batch([
  ...collections.map(kind=>db.prepare(`INSERT INTO workspace_records (owner,kind,id,payload,position)
   SELECT w.owner,?,${kind==='history'?"'history-' || j.key":"json_extract(j.value,'$.id')"},j.value,CAST(j.key AS INTEGER)
   FROM workspaces w,json_each(w.payload,?) j WHERE w.owner=? AND w.storage_version=0`).bind(kind,'$.'+kind,owner)),
  db.prepare("INSERT OR IGNORE INTO operation_receipts(owner,operation_id,fingerprint,revision,created_at) SELECT w.owner,j.value,'',w.revision,w.updated_at FROM workspaces w,json_each(w.payload,'$.appliedIds') j WHERE w.owner=? AND w.storage_version=0").bind(owner),
  db.prepare("UPDATE workspaces SET payload=json_remove(payload,'$.projects','$.tasks','$.blocks','$.contacts','$.resources','$.messages','$.history'),storage_version=1 WHERE owner=? AND storage_version=0").bind(owner)
 ]);
}
export async function loadWorkspace(db:D1Database,owner:string):Promise<Snapshot>{
 await ensureWorkspace(db,owner);
 const [header,rows]=await db.batch([
  db.prepare('SELECT payload,revision FROM workspaces WHERE owner=?').bind(owner),
  db.prepare('SELECT kind,id,payload,position FROM workspace_records WHERE owner=? ORDER BY kind,position').bind(owner)
 ]);
 const row=header.results[0] as {payload:string;revision:number}|undefined;
 if(!row)throw new Error('工作空间读取失败，请稍后重试。');
 return {...assembleWorkspace(row.payload,rows.results as StoredRecord[],row.revision),scope:fingerprint(owner).slice(0,24)};
}
export async function workspaceRevision(db:D1Database,owner:string){return (await db.prepare('SELECT revision FROM workspaces WHERE owner=?').bind(owner).first<{revision:number}>())?.revision??-1;}

// JSON is only a bounded transport parameter here, never one large database row.
// A large restore still uses one atomic batch and a bounded number of statements.
export function jsonChunks(values:unknown[],limit=512000):string[]{
 const chunks:string[]=[];let group:string[]=[],size=2;
 for(const value of values){const json=JSON.stringify(value),bytes=encoder.encode(json).length+1;if(bytes>limit)throw new Error('单条记录内容过大，请缩短说明后重试。');if(size+bytes>limit&&group.length){chunks.push('['+group.join(',')+']');group=[];size=2;}group.push(json);size+=bytes;}
 if(group.length)chunks.push('['+group.join(',')+']');return chunks;
}
export const commitGuard='EXISTS (SELECT 1 FROM workspaces WHERE owner=? AND commit_token=?)';
function flat(data:Data){return collections.flatMap(kind=>data[kind].map((value,position)=>({kind,id:'id' in value?String(value.id):'history-'+position,payload:value,position})));}
export function recordStatements(db:D1Database,owner:string,token:string,before:Data,after:Data){
 const previous=new Map(flat(before).map(r=>[r.kind+':'+r.id,r])),next=flat(after),wanted=new Set(next.map(r=>r.kind+':'+r.id));
 const upserts=next.filter(r=>JSON.stringify(previous.get(r.kind+':'+r.id))!==JSON.stringify(r)),deletes=[...previous.values()].filter(r=>!wanted.has(r.kind+':'+r.id));
 return [
  ...jsonChunks(deletes.map(r=>({kind:r.kind,id:r.id}))).map(chunk=>db.prepare(`DELETE FROM workspace_records WHERE owner=? AND (kind,id) IN (SELECT json_extract(value,'$.kind'),json_extract(value,'$.id') FROM json_each(?)) AND ${commitGuard}`).bind(owner,chunk,owner,token)),
  ...jsonChunks(upserts).map(chunk=>db.prepare(`INSERT INTO workspace_records (owner,kind,id,payload,position)
   SELECT ?,json_extract(value,'$.kind'),json_extract(value,'$.id'),json_extract(value,'$.payload'),json_extract(value,'$.position') FROM json_each(?) WHERE ${commitGuard}
   ON CONFLICT(owner,kind,id) DO UPDATE SET payload=excluded.payload,position=excluded.position`).bind(owner,chunk,owner,token))
 ];
}
export function commitHeader(db:D1Database,owner:string,current:Snapshot,data:Data,token:string,condition='',args:unknown[]=[]){
 return db.prepare('UPDATE workspaces SET payload=?,revision=revision+1,updated_at=?,commit_token=? WHERE owner=? AND revision=? AND storage_version=1'+condition).bind(metadata(data),new Date().toISOString(),token,owner,current.revision,...args);
}
export type OperationReceipt={fingerprint:string;revision:number;status:'applied'|'cancelled';records:ChangeBaseline['records']};
export async function readOperation(db:D1Database,owner:string,id:string):Promise<OperationReceipt|null>{
 const receipt=await db.prepare('SELECT fingerprint,revision,status FROM operation_receipts WHERE owner=? AND operation_id=?').bind(owner,id).first<Omit<OperationReceipt,'records'>>();
 if(!receipt)return null;
 const rows=(await db.prepare('SELECT kind,id,payload FROM operation_effects WHERE owner=? AND operation_id=?').bind(owner,id).all<{kind:ChangeBaseline['records'][number]['kind'];id:string;payload:string|null}>()).results;
 return {...receipt,records:rows.map(r=>({kind:r.kind,id:r.id,value:r.payload?JSON.parse(r.payload):null}))};
}
// Establish a durable fence before replacing an uncertain request. Either its
// original transaction won, or this cancellation prevents any late copy writing.
export async function settleOperation(db:D1Database,owner:string,id:string,hash:string){
 await db.prepare("INSERT OR IGNORE INTO operation_receipts(owner,operation_id,fingerprint,revision,created_at,status) SELECT ?,?,?,revision,?,'cancelled' FROM workspaces WHERE owner=?").bind(owner,id,hash,new Date().toISOString(),owner).run();
 const receipt=await readOperation(db,owner,id);if(!receipt)throw new Error('暂时无法确认上次保存，请稍后重试。');if(receipt.fingerprint&&receipt.fingerprint!==hash)throw new Error('保存回执与草稿不匹配，原草稿仍保留。');return receipt;
}
export function operationEffects(before:Data,after:Data):ChangeBaseline['records']{
 return kinds.flatMap(kind=>{const old=new Map(records(before,kind).map(v=>[v.id,v])),next=new Map(records(after,kind).map(v=>[v.id,v]));return [...new Set([...old.keys(),...next.keys()])].filter(id=>JSON.stringify(old.get(id))!==JSON.stringify(next.get(id))).map(id=>({kind,id,value:next.get(id)||null}));});
}
export async function commitRecords(db:D1Database,owner:string,current:Snapshot,data:Data,operationId:string,hash:string){
 const token=crypto.randomUUID(),applying=operationId.endsWith('-apply');
 let condition=' AND NOT EXISTS (SELECT 1 FROM operation_receipts WHERE owner=? AND operation_id=?)',args:unknown[]=[owner,operationId];
 if(applying){condition+=" AND EXISTS (SELECT 1 FROM chat_receipts WHERE owner=? AND request_id=? AND proposal_state='pending' AND proposal IS NOT NULL)";args.push(owner,operationId.slice(0,-6));}
 const effects=operationEffects(current.data,data);
 const result=await db.batch([
  commitHeader(db,owner,current,data,token,condition,args),
  ...recordStatements(db,owner,token,current.data,data),
  db.prepare(`INSERT INTO operation_receipts(owner,operation_id,fingerprint,revision,created_at) SELECT ?,?,?,?,? WHERE ${commitGuard}`).bind(owner,operationId,hash,current.revision+1,new Date().toISOString(),owner,token),
  ...jsonChunks(effects).map(chunk=>db.prepare(`INSERT INTO operation_effects(owner,operation_id,kind,id,payload) SELECT ?,?,json_extract(value,'$.kind'),json_extract(value,'$.id'),json_extract(value,'$.value') FROM json_each(?) WHERE ${commitGuard}`).bind(owner,operationId,chunk,owner,token)),
  ...(applying?[db.prepare(`UPDATE chat_receipts SET proposal_state='applied' WHERE owner=? AND request_id=? AND ${commitGuard}`).bind(owner,operationId.slice(0,-6),owner,token)]:[])
 ]);
 return result[0].meta.changes===1;
}
