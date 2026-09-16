import {baselineSchema,kinds,captureBaseline,stable,type ChangeBaseline,type Kind} from './changes.ts';
import {type Data,type Operation} from './domain.ts';
import {type OperationReceipt} from './workspace-storage.ts';
export type EditorDraft={version:1;kind:Kind;id:string;record:Record<string,any>|null;baseline:ChangeBaseline;deletionBaseline:ChangeBaseline;entries:[string,string][];attempt?:{fingerprint:string;id:string;operations?:Operation[];baseline?:ChangeBaseline;summary?:string}};
export function acknowledgeDraft(draft:EditorDraft,receipt:OperationReceipt,data:Data):EditorDraft {
 if(receipt.status!=='applied')return {...draft,attempt:undefined};
 const effect=receipt.records.find(r=>r.kind===draft.kind&&r.id===draft.id);
 if(!effect)return {...draft,attempt:undefined};
 return {...draft,record:effect.value,baseline:{records:[effect],deletions:{}},deletionBaseline:captureBaseline(data,[{type:draft.kind+'.delete' as Operation['type'],id:draft.id}]),attempt:undefined};
}
export function rebaseSubmittedOperations(previous:Operation[],wanted:Operation[],receipt:OperationReceipt):Operation[]{
 if(receipt.status!=='applied')return wanted;
 return wanted.map(op=>{if(!op.type.endsWith('.save'))return op;const value=op.data as Record<string,unknown>,prior=previous.find(p=>p.type===op.type&&(p.data as any)?.id===value.id)?.data as Record<string,unknown>|undefined,effect=receipt.records.find(r=>r.kind===op.type.split('.')[0]&&r.id===value.id)?.value;
  if(!prior||!effect)return op;const merged={...effect};for(const [field,content] of Object.entries(value))if(field!=='updatedAt'&&stable(content)!==stable(prior[field]))merged[field]=content;return {...op,data:merged};
 });
}
const prefix='time-master-editor-v1:';
export function draftKey(item:{kind:string;id?:string;projectId?:string;taskId?:string;date?:string;status?:string}){return prefix+JSON.stringify([item.kind,item.id||'new',item.id?'':item.projectId||'',item.id?'':item.taskId||'',item.id||item.kind!=='block'?'':item.date||'',item.id?'':item.status||'']);}
export function readDraft(key:string):EditorDraft|null{try{const d=JSON.parse(sessionStorage.getItem(key)||'null');return key.startsWith(prefix)&&d?.version===1&&kinds.includes(d.kind)&&typeof d.id==='string'&&Array.isArray(d.entries)&&d.entries.every((e:unknown)=>Array.isArray(e)&&e.length===2&&e.every(v=>typeof v==='string'))&&baselineSchema.safeParse(d.baseline).success?d:null}catch{return null}}
function changed(){if(typeof window!=='undefined')window.dispatchEvent(new Event('time-master-drafts-changed'));}
export function writeDraft(key:string,draft:EditorDraft){try{sessionStorage.setItem(key,JSON.stringify(draft));changed();return true}catch{return false}}
export function clearDraft(key:string){try{sessionStorage.removeItem(key);changed()}catch{}}
export function listDrafts(){const drafts:{key:string;draft:EditorDraft}[]=[];try{for(let i=0;i<sessionStorage.length;i++){const key=sessionStorage.key(i)!;if(!key.startsWith(prefix))continue;const draft=readDraft(key);if(draft?.entries.length)drafts.push({key,draft});}}catch{}return drafts;}
export function draftAsNew(draft:EditorDraft,data:Data,newId=crypto.randomUUID()):EditorDraft{
 const entries=draft.entries.filter(([key,value])=>key!=='id'&&(key!=='dependencies'||data.tasks.some(t=>t.id===value))&&(!key.startsWith('role-')||data.projects.some(p=>key==='role-project-'+p.id||key==='role-'+p.id))).map(([key,value]):[string,string]=>{
  if(key==='projectId'&&!data.projects.some(p=>p.id===value)||key==='contactId'&&!data.contacts.some(c=>c.id===value)||key==='taskId'&&!data.tasks.some(t=>t.id===value))return [key,''];return [key,value];
 });
 return {...draft,id:newId,record:null,baseline:captureBaseline(data,[{type:draft.kind+'.save' as any,data:{id:newId}}]),deletionBaseline:{records:[],deletions:{}},entries,attempt:undefined};
}
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
