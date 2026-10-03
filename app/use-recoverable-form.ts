'use client';
import {useLayoutEffect,useRef,useState} from 'react';
import {formEntries,restoreEntries} from '@/lib/editor-draft';
/** Persist fields, stable IDs, original records and uncertain attempts together. */
export function useRecoverableForm<T>(key:string,create:()=>T){
 const [initial]=useState(()=>{try{const saved=JSON.parse(sessionStorage.getItem(key)||'null');if(saved?.version===1&&saved.state&&typeof saved.state==='object'&&Array.isArray(saved.entries)&&saved.entries.every((e:unknown)=>Array.isArray(e)&&e.length===2&&e.every(v=>typeof v==='string')))return saved as {version:1;state:T;entries:[string,string][]}}catch{}return {version:1 as const,state:create(),entries:[] as [string,string][]}});
 const form=useRef<HTMLFormElement>(null),state=useRef(initial.state);
 useLayoutEffect(()=>{if(form.current&&initial.entries.length)restoreEntries(form.current,initial.entries)},[]);
 function persist(){sessionStorage.setItem(key,JSON.stringify({version:1,state:state.current,entries:form.current?formEntries(form.current):initial.entries}))}
 function clear(){try{sessionStorage.removeItem(key)}catch{}}
 return {form,state,entries:initial.entries,persist,clear};
}
