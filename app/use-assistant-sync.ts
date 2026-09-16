'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {type Data} from '@/lib/domain';
import {type ChatCursor} from '@/lib/chat-state';
import {mergeMessages} from '@/lib/chat-history';
import {requestJson,errorMessage} from '@/lib/api-client';
type Page={messages:Data['messages'];nextCursor:ChatCursor|null;watermark:number};
type Update={messages:Data['messages'];nextAfter:number;watermark:number;hasMore:boolean};
export function useAssistantSync(revision:number,liveMessages:Data['messages'],beforePrepend:()=>void){
 const [messages,setMessages]=useState<Data['messages']>([]),[historyCursor,setHistoryCursor]=useState<ChatCursor|null>(null),[historyLoaded,setHistoryLoaded]=useState(false),[historyBusy,setHistoryBusy]=useState(false),[historyError,setHistoryError]=useState(''),[syncError,setSyncError]=useState(''),[syncedRevision,setSyncedRevision]=useState(-1);
 const alive=useRef(false),initialized=useRef(false),after=useRef(0),target=useRef(revision),dirty=useRef(true),flight=useRef<AbortController|null>(null),older=useRef<AbortController|null>(null),before=useRef<ChatCursor|null>(null),retryTimer=useRef<ReturnType<typeof setTimeout>|null>(null),failures=useRef(0),drainRef=useRef<()=>Promise<void>>(async()=>{}),prepend=useRef(beforePrepend);prepend.current=beforePrepend;
 const merge=useCallback((incoming:Data['messages'])=>{if(incoming.length)setMessages(old=>mergeMessages(old,incoming))},[]);
 const canRun=()=>alive.current&&document.visibilityState!=='hidden'&&navigator.onLine!==false;
 const wake=useCallback(()=>{dirty.current=true;if(retryTimer.current)clearTimeout(retryTimer.current);void drainRef.current()},[]);
 const drain=useCallback(async()=>{
  if(flight.current||!canRun()||(!dirty.current&&initialized.current&&after.current>=target.current))return;
  const controller=new AbortController();flight.current=controller;let failed=false;
  const active=()=>alive.current&&flight.current===controller&&!controller.signal.aborted;
  const request=<T,>(url:string)=>requestJson<T>(url,undefined,{signal:controller.signal,retries:0,timeoutMs:20000});
  try{do{
   dirty.current=false;
   if(!initialized.current){const page=await request<Page>('/api/qwen/history');if(!active())return;merge(page.messages);before.current=page.nextCursor;setHistoryCursor(page.nextCursor);setHistoryLoaded(true);after.current=page.watermark;target.current=Math.max(target.current,page.watermark);initialized.current=true;setSyncedRevision(page.watermark);}
   const until=target.current;
   while(after.current<until){const previous=after.current,page=await request<Update>(`/api/qwen/history?after=${previous}&until=${until}`);if(!active())return;
    if(page.watermark!==until||page.nextAfter<=previous||page.nextAfter>until||(!page.hasMore&&page.nextAfter!==until))throw new Error('对话同步结果不完整，正在重试。');
    merge(page.messages);after.current=page.nextAfter;setSyncedRevision(page.nextAfter);
   }
   failures.current=0;setSyncError('');
  }while(active()&&canRun()&&(dirty.current||after.current<target.current));
  }catch(e){if(active()){failed=true;dirty.current=true;failures.current++;setSyncError(errorMessage(e));}}
  finally{if(flight.current===controller){flight.current=null;if(canRun()){if(failed)retryTimer.current=setTimeout(()=>void drainRef.current(),Math.min(30000,1000*2**Math.min(failures.current,5)));else if(dirty.current||after.current<target.current)queueMicrotask(()=>void drainRef.current());}}}
 },[merge]);drainRef.current=drain;
 const loadOlder=useCallback(async()=>{
  if(!initialized.current){wake();return;}if(!before.current||older.current)return;
  const cursor=before.current,controller=new AbortController();older.current=controller;setHistoryBusy(true);setHistoryError('');
  try{const page=await requestJson<Page>('/api/qwen/history?cursor='+encodeURIComponent(JSON.stringify(cursor)),undefined,{signal:controller.signal});if(!alive.current||controller.signal.aborted)return;prepend.current();merge(page.messages);before.current=page.nextCursor;setHistoryCursor(page.nextCursor);}catch(e){if(alive.current&&!controller.signal.aborted)setHistoryError(errorMessage(e));}finally{if(older.current===controller){older.current=null;if(alive.current)setHistoryBusy(false);}}
 },[merge,wake]);
 useEffect(()=>{alive.current=true;window.addEventListener('online',wake);window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);wake();return()=>{alive.current=false;flight.current?.abort();older.current?.abort();flight.current=null;older.current=null;if(retryTimer.current)clearTimeout(retryTimer.current);window.removeEventListener('online',wake);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake)}},[wake]);
 useEffect(()=>{target.current=Math.max(target.current,revision);wake()},[revision,wake]);
 useEffect(()=>merge(liveMessages),[liveMessages,merge]);
 return {messages,historyCursor,historyLoaded,historyBusy,historyError,loadOlder,syncError,retrySync:wake,caughtUp:historyLoaded&&syncedRevision>=revision&&!syncError};
}
