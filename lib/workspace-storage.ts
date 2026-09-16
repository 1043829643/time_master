import {reconcileMemoryStatements} from './conversation-memory.ts';
import {emptyData,validateData,type Data,type Snapshot,type Operation} from './domain.ts';
import {kinds,records,captureBaseline,stable,type ChangeBaseline} from './changes.ts';
import {fingerprint} from './fingerprint.ts';
import {transitionsForWrite,transitionStatements} from './proposal-lifecycle.ts';

export const collections=['projects','tasks','blocks','contacts','resources','captures','followups','messages','history'] as const;
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
  db.prepare("UPDATE workspaces SET payload=json_remove(payload,'$.projects','$.tasks','$.blocks','$.contacts','$.resources','$.captures','$.followups','$.messages','$.history'),storage_version=1 WHERE owner=? AND storage_version=0").bind(owner)
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
export type OperationReceipt={fingerprint:string;revision:number;status:'applied'|'cancelled';records:ChangeBaseline['records'];before?:ChangeBaseline['records'];undoBaseline?:ChangeBaseline;undoable?:boolean};
export async function readOperation(db:D1Database,owner:string,id:string):Promise<OperationReceipt|null>{
 const receipt=await db.prepare('SELECT fingerprint,revision,status FROM operation_receipts WHERE owner=? AND operation_id=?').bind(owner,id).first<Omit<OperationReceipt,'records'>>();
 if(!receipt)return null;
 const rows=(await db.prepare('SELECT kind,id,payload,before_payload,undo_scope FROM operation_effects WHERE owner=? AND operation_id=?').bind(owner,id).all<{kind:ChangeBaseline['records'][number]['kind'];id:string;payload:string|null;before_payload:string|null;undo_scope:string|null}>()).results;
 const effects=rows.map(r=>({kind:r.kind,id:r.id,value:r.payload?JSON.parse(r.payload):null})),before=rows.map(r=>({kind:r.kind,id:r.id,value:r.before_payload?JSON.parse(r.before_payload):null}));
 const undoable=receipt.status==='applied'&&rows.length>0&&rows.length<=60&&rows.every(r=>r.undo_scope!==null);
 return {...receipt,records:effects,before,undoable,undoBaseline:undoable?{records:effects,deletions:Object.fromEntries(rows.filter(r=>r.undo_scope?.startsWith('sha256:')).map(r=>[r.kind+':'+r.id,r.undo_scope!]))}:undefined};
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
export function inverseOperations(receipt:Pick<OperationReceipt,'before'|'records'>):Operation[]{
 if(!receipt.before)throw new Error('这次操作没有保存撤销信息。');
 const rank:Record<string,number>={project:0,contact:1,task:2,resource:3,block:4,followup:5,capture:6};
 return receipt.before.map(r=>r.value?{type:r.kind+'.save' as Operation['type'],data:r.value,unset:Object.keys(receipt.records.find(v=>v.kind===r.kind&&v.id===r.id)?.value||{}).filter(k=>!(k in r.value!))}:{type:r.kind+'.delete' as Operation['type'],id:r.id}).sort((a,b)=>{
  const da=a.type.endsWith('.delete'),db=b.type.endsWith('.delete');if(da!==db)return da?1:-1;
  return (da?-1:1)*(rank[a.type.split('.')[0]]-rank[b.type.split('.')[0]]);
 });
}
/** Shared by manual edits and agent execution; effects are read back inside the write transaction. */
export function operationReceiptStatements(db:D1Database,owner:string,token:string,before:Data,after:Data,operationId:string,revision:number,hash=''){
 const effects=operationEffects(before,after),prior=effects.map(r=>({...r,value:records(before,r.kind).find(v=>v.id===r.id)||null}));
 const inverse=inverseOperations({records:effects,before:prior}),baseline=captureBaseline(after,inverse);
 const stored=effects.map((r,i)=>({...r,collection:r.kind==='followup'?'followups':r.kind+'s',before:prior[i].value,undoScope:effects.length<=60?(baseline.deletions[r.kind+':'+r.id]||'captured'):null}));
 return [db.prepare(`INSERT INTO operation_receipts(owner,operation_id,fingerprint,revision,created_at) SELECT ?,?,?,?,? WHERE ${commitGuard}`).bind(owner,operationId,hash,revision,new Date().toISOString(),owner,token),
  ...jsonChunks(stored).map(chunk=>db.prepare(`INSERT INTO operation_effects(owner,operation_id,kind,id,payload,before_payload,undo_scope)
   SELECT ?,?,json_extract(j.value,'$.kind'),json_extract(j.value,'$.id'),
    (SELECT r.payload FROM workspace_records r WHERE r.owner=? AND r.kind=json_extract(j.value,'$.collection') AND r.id=json_extract(j.value,'$.id')),
    json_extract(j.value,'$.before'),json_extract(j.value,'$.undoScope') FROM json_each(?) j WHERE ${commitGuard}`).bind(owner,operationId,owner,chunk,owner,token))];
}
export function verifyOperation(receipt:OperationReceipt|null,expected:ChangeBaseline['records']){
 if(!receipt||receipt.status!=='applied'||expected.length!==receipt.records.length||expected.some(e=>!receipt.records.some(r=>r.kind===e.kind&&r.id===e.id&&stable(r.value)===stable(e.value))))throw new Error('已收到保存结果，正在核对实际变化。请用原请求重试，不要重复新建。');
 return receipt;
}
export async function commitRecords(db:D1Database,owner:string,current:Snapshot,data:Data,operationId:string,hash:string){
 const token=crypto.randomUUID(),applying=operationId.endsWith('-apply');
 let condition=' AND NOT EXISTS (SELECT 1 FROM operation_receipts WHERE owner=? AND operation_id=?)',args:unknown[]=[owner,operationId];
 if(applying){condition+=" AND EXISTS (SELECT 1 FROM chat_receipts WHERE owner=? AND request_id=? AND proposal_state='pending' AND proposal IS NOT NULL)";args.push(owner,operationId.slice(0,-6));}
 const effects=operationEffects(current.data,data);
 const transitions=await transitionsForWrite(db,owner,current.data,data,effects,applying?operationId.slice(0,-6):undefined);
 const result=await db.batch([
  commitHeader(db,owner,current,data,token,condition,args),
  ...recordStatements(db,owner,token,current.data,data),
  ...operationReceiptStatements(db,owner,token,current.data,data,operationId,current.revision+1,hash),
  ...transitionStatements(db,owner,token,transitions),
  ...(applying?[db.prepare(`UPDATE chat_receipts SET proposal_state='applied' WHERE owner=? AND request_id=? AND ${commitGuard}`).bind(owner,operationId.slice(0,-6),owner,token)]:[]),
  ...reconcileMemoryStatements(db,owner,token)
 ]);
 return result[0].meta.changes===1;
}
