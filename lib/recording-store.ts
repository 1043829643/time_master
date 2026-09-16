export type SavedRecording={id:string;blob:Blob;createdAt:string;transcript?:string;delivered?:boolean};
export class RecordingOccupiedError extends Error {constructor(){super('另一个页面还有一段待处理录音。请先完成那段录音，或下载当前录音后稍后重试。');}}
export class RecordingConsumedError extends Error {constructor(){super('这段录音已在另一个页面处理或放弃，可以继续录制。');}}
function open(){return new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('time-master-recovery',1);request.onupgradeneeded=()=>request.result.createObjectStore('recordings');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
export async function recordingStore(scope:string,action:'read'|'save'|'delete',value?:SavedRecording):Promise<SavedRecording|null>{
 const db=await open();try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction('recordings',action==='read'?'readonly':'readwrite'),store=tx.objectStore('recordings'),request=store.get(scope);let result:SavedRecording|null=null,problem:Error|null=null;
  request.onsuccess=()=>{const current=request.result as SavedRecording|undefined;
   if(action==='read'){result=current||null;return;}
   if(!value){problem=new Error('缺少录音');tx.abort();return;}
   const receiptKey=[scope,'consumed',value.id],receipt=store.get(receiptKey);
   receipt.onsuccess=()=>{
    if(action==='save'){
     if(receipt.result||(current?.id===value.id&&current.delivered&&!value.delivered)){problem=new RecordingConsumedError();tx.abort();return;}
     if(current&&current.id!==value.id){problem=new RecordingOccupiedError();tx.abort();return;}
     store.put(value,scope);
    }
    if(action==='delete'){if(current?.id===value.id)store.delete(scope);store.put(true,receiptKey);}
   };
  };
  tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(problem||tx.error);tx.onabort=()=>reject(problem||tx.error);
 });}finally{db.close();}
}
