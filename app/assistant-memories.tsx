'use client';
import {useEffect,useState} from 'react';
import {type ConversationMemory} from '@/lib/conversation-memory';
import {type Snapshot,type Data} from '@/lib/domain';
import {requestJson,errorMessage} from '@/lib/api-client';
export function AssistantMemories({revision,data,receive}:{revision:number;data:Data;receive:(s:Snapshot)=>void}){
 const [items,setItems]=useState<ConversationMemory[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState('');
 useEffect(()=>{const controller=new AbortController();requestJson('/api/qwen/memories',undefined,{signal:controller.signal}).then(r=>{setItems(r.memories);setError('')}).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e))});return()=>controller.abort()},[revision]);
 async function forget(id:string){setBusy(id);try{const r=await requestJson('/api/qwen/memories',{id});setItems(r.memories);receive(r.snapshot);setError('')}catch(e){setError(errorMessage(e))}finally{setBusy('')}}
 const names=new Map([...data.projects,...data.tasks,...data.blocks,...data.contacts].map(v=>[v.id,v.name]));
 return <div className="assistant-memories"><p className="small muted">这些信息会用于后续安排。可以直接告诉我哪里不对，或移除不再适用的内容。</p>{error&&<p role="alert">{error}</p>}{!items.length&&!error&&<p>还没有记住的偏好或限制。</p>}{items.map(m=><article className="memory-card" key={m.id}><strong>{m.statement}</strong><small>{m.date?'适用日期：'+m.date:'持续有效'} · {m.certainty==='tentative'?'尚未确定':'已记录'}{m.subjectId&&<><br/>用于：{names.get(m.subjectId)||'之前的记录'}</>}</small><details><summary>当时你说</summary><p>{m.quote}</p></details><button className="text-button" disabled={!!busy} onClick={()=>forget(m.id)}>{busy===m.id?'正在移除…':'不再记住'}</button></article>)}</div>;
}
