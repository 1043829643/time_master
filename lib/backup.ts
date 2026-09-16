import {dataSchema,emptyData,validateData,type Data} from './domain.ts';
import {warningsForChange} from './planning.ts';
export const businessKeys=['projects','tasks','blocks','contacts','resources'] as const;
export type BusinessKey=typeof businessKeys[number];
export const businessSchema=dataSchema.pick({projects:true,tasks:true,blocks:true,contacts:true,resources:true});
export type BackupData=ReturnType<typeof businessSchema.parse>;
export type RestoreMode='missing'|'copies';
export function parseBackup(input:unknown):BackupData{
 if(!input||typeof input!=='object'||!('data' in input))throw new Error('请选择时间管理大师导出的 JSON 备份。');
 const file=input as {format?:string;version?:number;data:unknown};
 if(file.format&&file.format!=='time-master-backup'||file.version!==undefined&&file.version!==1)throw new Error('这个备份版本暂不支持。');
 const parsed=businessSchema.parse(file.data);validateData({...emptyData(),...parsed});return parsed;
}
export function restorePlan(current:Data,source:BackupData,mode:RestoreMode,requestId:string){
 const backup=businessSchema.parse(source);validateData({...emptyData(),...backup});
 const next=structuredClone(current),maps=Object.fromEntries(businessKeys.map(k=>[k,new Map(backup[k].map((v,i)=>[v.id,mode==='copies'?'restore-'+requestId+'-'+k+'-'+i:v.id]))])) as Record<BusinessKey,Map<string,string>>;
 const counts=Object.fromEntries(businessKeys.map(k=>[k,0])) as Record<BusinessKey,number>;
 for(const key of businessKeys)for(const original of backup[key]){
  const id=maps[key].get(original.id)!;if(current[key].some(v=>v.id===id))continue;
  const value:any={...structuredClone(original),id};
  if(mode==='copies'&&key==='projects')value.name=(value.name+'（恢复副本）').slice(0,160);
  if(key==='tasks'){value.projectId=maps.projects.get(value.projectId);value.dependencies=value.dependencies.map((id:string)=>maps.tasks.get(id));value.contactId=value.contactId?maps.contacts.get(value.contactId):'';}
  if(key==='blocks')value.taskId=value.taskId?maps.tasks.get(value.taskId):'';
  if(key==='resources')value.projectId=maps.projects.get(value.projectId);
  if(key==='contacts')value.roles=value.roles.map((r:any)=>({...r,projectId:maps.projects.get(r.projectId)}));
  (next[key] as any[]).push(value);counts[key]++;
 }
 // Expand a retained project's range if one of its restored children needs it.
 for(const t of next.tasks){const p=next.projects.find(p=>p.id===t.projectId);if(p){if(t.start<p.start)p.start=t.start;if(t.end>p.end)p.end=t.end;}}
 const data=validateData(next),rangeWarnings=data.projects.flatMap(p=>{const old=current.projects.find(v=>v.id===p.id);return old&&(old.start!==p.start||old.end!==p.end)?['为容纳恢复的事项，项目「'+p.name+'」的日期将从 '+old.start+' → '+old.end+' 扩展为 '+p.start+' → '+p.end+'。']:[]});
 return {data,counts,warnings:[...rangeWarnings,...warningsForChange(current,data).map(w=>w.message)],total:Object.values(counts).reduce((a,b)=>a+b,0)};
}
export function exportBackup(data:Data){return {format:'time-master-backup',version:1,exportedAt:new Date().toISOString(),timezone:'Asia/Shanghai',data};}
