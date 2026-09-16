export type OutboxItem={scope:string;id:string;text:string;createdAt:number;state:'queued'|'sending'|'failed';error?:string};
function open(){return new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('time-master-chat-outbox',1);r.onupgradeneeded=()=>{const s=r.result.createObjectStore('messages',{keyPath:['scope','id']});s.createIndex('scope','scope')};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});}
export async function outbox(scope:string,action:'list'|'put'|'update'|'remove',value?:OutboxItem|string):Promise<OutboxItem[]>{
 if(!scope)throw new Error('工作空间尚未确认，文字仍保留。');
 const db=await open();try{return await new Promise((resolve,reject)=>{const tx=db.transaction('messages',action==='list'?'readonly':'readwrite'),s=tx.objectStore('messages');let rows:OutboxItem[]=[];
 const read=()=>{const r=s.index('scope').getAll(scope);r.onsuccess=()=>{rows=r.result.sort((a:OutboxItem,b:OutboxItem)=>a.createdAt-b.createdAt)}};
 if(action==='put'||action==='update'){const item=value as OutboxItem,r=s.get([scope,item.id]);r.onsuccess=()=>{if(r.result&&r.result.text!==item.text){tx.abort();return}if(action==='put'&&!r.result||action==='update'&&r.result)s.put(item);read()}}
 else{if(action==='remove')s.delete([scope,value as string]);read()}
 tx.oncomplete=()=>resolve(rows);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
 });}finally{db.close()}
}
