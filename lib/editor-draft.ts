import {baselineSchema,type ChangeBaseline,type Kind} from './changes.ts';
export type EditorDraft={version:1;kind:Kind;id:string;record:Record<string,any>|null;baseline:ChangeBaseline;deletionBaseline:ChangeBaseline;entries:[string,string][];attempt?:{fingerprint:string;id:string}};
const prefix='time-master-editor-v1:';
export function draftKey(item:{kind:string;id?:string;projectId?:string;taskId?:string;date?:string;status?:string}){return prefix+JSON.stringify([item.kind,item.id||'new',item.id?'':item.projectId||'',item.id?'':item.taskId||'',item.id||item.kind!=='block'?'':item.date||'',item.id?'':item.status||'']);}
export function readDraft(key:string):EditorDraft|null{try{const d=JSON.parse(sessionStorage.getItem(key)||'null');return d?.version===1&&typeof d.id==='string'&&Array.isArray(d.entries)&&baselineSchema.safeParse(d.baseline).success?d:null}catch{return null}}
export function writeDraft(key:string,draft:EditorDraft){try{sessionStorage.setItem(key,JSON.stringify(draft));return true}catch{return false}}
export function clearDraft(key:string){try{sessionStorage.removeItem(key)}catch{}}
export function formEntries(form:HTMLFormElement):[string,string][]{return [...new FormData(form).entries()].map(([key,value])=>[key,String(value)]);}
export function restoreEntries(form:HTMLFormElement,entries:[string,string][]){
 for(const el of Array.from(form.elements)){
  if(!(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement||el instanceof HTMLSelectElement)||!el.name)continue;
  const values=entries.filter(([key])=>key===el.name).map(([,value])=>value);
  if(el instanceof HTMLInputElement&&(el.type==='checkbox'||el.type==='radio'))el.checked=values.includes(el.value);else el.value=values[0]??'';
 }
}
export function recordEntries(value:Record<string,any>):[string,string][]{
 const result:[string,string][]=[];
 for(const [key,v] of Object.entries(value)){
  if(key==='roles'){for(const role of v as {projectId:string;role:string}[]){result.push(['role-project-'+role.projectId,'on'],['role-'+role.projectId,role.role]);}}
  else if(key==='dependencies'){for(const id of v as string[])result.push([key,id]);}
  else if(typeof v==='boolean'){if(v)result.push([key,'on']);}
  else if(v!==null&&v!==undefined)result.push([key,String(v)]);
 }
 return result;
}
