'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {emptyData,type Snapshot,type Operation} from '@/lib/domain';
import {captureBaseline,type ChangeBaseline,type FieldConflict} from '@/lib/changes';
import {requestJson,ClientError,errorMessage} from '@/lib/api-client';
import {useConfirmation} from './confirmation';

export type ConflictDetails={code:string;snapshot:Snapshot;conflicts:FieldConflict[];operations?:Operation[];message?:string};
export type SaveOptions={baseline?:ChangeBaseline;workRevision?:number;operationId?:string;onConflict?:(detail:ConflictDetails)=>void};
export type SaveWorkspace=(operations:Operation[],summary:string,options?:SaveOptions)=>Promise<boolean>;
export function useWorkspace(){
 const {confirm,dialog}=useConfirmation();
 const [snapshot,setSnapshot]=useState<Snapshot>({data:emptyData(),revision:0}),[loading,setLoading]=useState(true),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState<{text:string;error?:boolean}|null>(null),[syncState,setSyncState]=useState<'loading'|'synced'|'offline'|'error'>('loading'),[lastSynced,setLastSynced]=useState('');
 const latest=useRef(snapshot),saving=useRef(false),channel=useRef<BroadcastChannel|null>(null),noticeTimer=useRef<ReturnType<typeof setTimeout>|null>(null),saveAttempt=useRef<{fingerprint:string;body:any}|null>(null);
 const notify=useCallback((text:string,error=false)=>{if(noticeTimer.current)clearTimeout(noticeTimer.current);setNotice({text,error});if(!error)noticeTimer.current=setTimeout(()=>setNotice(null),4500)},[]);
 const receive=useCallback((s:Snapshot)=>{if(s.revision>=latest.current.revision){const newer=s.revision>latest.current.revision;latest.current=s;setSnapshot(s);if(newer)channel.current?.postMessage({revision:s.revision})}setLoaded(true);setSyncState('synced');setLastSynced(new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}))},[]);
 const sync=useCallback(async()=>{try{const s=await requestJson<Snapshot>('/api/workspace');receive(s);return s}catch(e){setSyncState(navigator.onLine?'error':'offline');throw e}},[receive]);
 const reload=useCallback(async()=>{setLoading(true);try{await sync();setNotice(null)}catch(e){notify(errorMessage(e),true)}finally{setLoading(false)}},[sync,notify]);
 useEffect(()=>{void reload();return()=>{if(noticeTimer.current)clearTimeout(noticeTimer.current)}},[reload]);
 useEffect(()=>{let refreshing=false;const refresh=()=>{if(document.visibilityState==='hidden'||refreshing||saving.current)return;refreshing=true;void sync().catch(()=>{}).finally(()=>{refreshing=false})};const offline=()=>setSyncState('offline');const onMessage=(event:MessageEvent)=>{if(event.data?.revision>latest.current.revision)refresh()};if(typeof BroadcastChannel!=='undefined'){channel.current=new BroadcastChannel('time-master-workspace');channel.current.addEventListener('message',onMessage)}window.addEventListener('focus',refresh);window.addEventListener('online',refresh);window.addEventListener('offline',offline);document.addEventListener('visibilitychange',refresh);const poll=setInterval(refresh,30000);return()=>{clearInterval(poll);window.removeEventListener('focus',refresh);window.removeEventListener('online',refresh);window.removeEventListener('offline',offline);document.removeEventListener('visibilitychange',refresh);channel.current?.close();channel.current=null}},[sync]);
 const save:SaveWorkspace=useCallback(async(operations,summary,options={})=>{
  if(saving.current)return false;saving.current=true;setBusy(true);
  try{
  const baseline=options.baseline||captureBaseline(snapshot.data,operations),fingerprint=JSON.stringify({operations,summary,baseline,id:options.operationId});
  if(saveAttempt.current?.fingerprint!==fingerprint)saveAttempt.current={fingerprint,body:{revision:latest.current.revision,workRevision:options.workRevision??snapshot.data.workRevision,baseline,operations,operationId:options.operationId||crypto.randomUUID(),summary}};
  const body=saveAttempt.current.body;
   for(let attempt=0;attempt<4;attempt++){
    try{const s=await requestJson<Snapshot>('/api/workspace',body);receive(s);saveAttempt.current=null;notify('已保存：'+summary);return true}
    catch(e){
     if(e instanceof ClientError&&e.details?.snapshot)receive(e.details.snapshot);
     if(e instanceof ClientError&&e.details?.code==='REVIEW_REQUIRED'){
      const warnings=e.details.warnings as {message:string}[];
      if(!await confirm(warnings.map(w=>w.message).join('\n\n')+'\n\n确认后保存这次修改。'))return false;
      body.reviewedRevision=e.details.snapshot.data.workRevision;continue;
     }
     if(e instanceof ClientError&&['FIELD_CONFLICT','INVALID_MERGE'].includes(e.details?.code)&&options.onConflict){saveAttempt.current=null;options.onConflict(e.details);return false;}
     if(e instanceof ClientError&&e.status===409)saveAttempt.current=null;
     if(!(e instanceof ClientError)||e.status===0||e.status>=500)setSyncState(navigator.onLine?'error':'offline');
     notify(errorMessage(e),true);return false;
    }
   }
   notify('其他页面持续更新，请稍后再保存。输入和草稿仍保留。',true);return false;
  }catch(e){notify(errorMessage(e),true);return false}finally{saving.current=false;setBusy(false)}
 },[snapshot,receive,notify,confirm]);
 return {snapshot,loading,loaded,busy,notice,setNotice,notify,receive,reload,save,syncState,lastSynced,dialog};
}
