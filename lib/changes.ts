import {z} from 'zod';
import {fingerprint} from './fingerprint.ts';
import {applyOperations,operationSchema,validateOperationOrder,type Data,type Operation} from './domain.ts';

export const kinds=['project','task','block','contact','resource','capture','followup'] as const;
export type Kind=typeof kinds[number];
type RecordValue=Record<string,any>;
export const baselineSchema=z.object({records:z.array(z.object({kind:z.enum(kinds),id:z.string().min(1).max(100),value:z.record(z.unknown()).nullable()})).max(120),deletions:z.record(z.string()).default({})});
export type ChangeBaseline=z.infer<typeof baselineSchema>;
export type FieldConflict={kind:Kind;id:string;name:string;field:string;base:unknown;current:unknown;proposed:unknown};
export class ChangeConflict extends Error{
 conflicts:FieldConflict[];
 constructor(conflicts:FieldConflict[]){super('同一处内容有新的修改，请选择保留的内容。');this.name='ChangeConflict';this.conflicts=conflicts;}
}
export class MergeValidationError extends Error{operations:Operation[];constructor(message:string,operations:Operation[]){super(message);this.name='MergeValidationError';this.operations=operations;}}
export function records(data:Data,kind:Kind):RecordValue[]{return data[({project:'projects',task:'tasks',block:'blocks',contact:'contacts',resource:'resources',capture:'captures',followup:'followups'} as const)[kind]];}
export function stable(value:unknown):string{
 if(value===undefined)return 'null';
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 return '{'+Object.keys(value).filter(k=>k!=='updatedAt').sort().map(k=>JSON.stringify(k)+':'+stable((value as RecordValue)[k])).join(',')+'}';
}
const same=(a:unknown,b:unknown)=>stable(a)===stable(b);
function target(op:Operation){const kind=op.type.split('.')[0] as Kind,id=op.type.endsWith('.save')?(op.data as RecordValue)?.id:op.id;if(!kinds.includes(kind)||typeof id!=='string')throw new Error('修改缺少有效的记录编号。');return {kind,id};}
// Compare the entire cascading effect of deletion, including newly linked records.
function deletionScope(data:Data,kind:Kind,id:string){
 const value=records(data,kind).find(r=>r.id===id);if(!value)return 'missing';
 const tasks=new Set(kind==='project'?data.tasks.filter(t=>t.projectId===id).map(t=>t.id):kind==='task'?[id]:[]);
 const affected:any={value};
 if(kind==='project'||kind==='task'||kind==='contact'||kind==='followup'){affected.captures=data.captures.filter(c=>kind==='project'?c.projectId===id||tasks.has(c.taskId):kind==='task'?c.taskId===id:kind==='followup'?c.followupId===id:false);affected.followups=data.followups.filter(f=>kind==='project'?f.projectId===id||tasks.has(f.taskId):kind==='task'?f.taskId===id:kind==='contact'?f.contactId===id:false);}
 if(tasks.size||kind==='project'){
  affected.tasks=data.tasks.filter(t=>tasks.has(t.id)||t.dependencies.some(dep=>tasks.has(dep)));
  affected.blocks=data.blocks.filter(b=>tasks.has(b.taskId));
 }
 if(kind==='project'){affected.resources=data.resources.filter(r=>r.projectId===id);affected.contacts=data.contacts.filter(c=>c.roles.some(r=>r.projectId===id));}
 if(kind==='contact'){affected.tasks=data.tasks.filter(t=>t.contactId===id);affected.blocks=data.blocks.filter(b=>b.contactId===id);}
 return stable(affected);
}
export function captureBaseline(data:Data,operations:Operation[]):ChangeBaseline{
 const found=new Map<string,ChangeBaseline['records'][number]>(),deletions:Record<string,string>={};
 for(const op of operations){const {kind,id}=target(op),key=kind+':'+id;if(!found.has(key))found.set(key,{kind,id,value:structuredClone(records(data,kind).find(r=>r.id===id)||null)});if(op.type.endsWith('.delete'))deletions[key]='sha256:'+fingerprint(deletionScope(data,kind,id));}
 return {records:[...found.values()],deletions};
}
/** Three-way merge preserves current fields the user did not edit. Arrays are atomic fields. */
export function mergeChanges(current:Data,raw:unknown,rawBaseline:ChangeBaseline,resolution?:'mine'|'theirs'|Record<string,string>):Operation[]{
 const operations=z.array(operationSchema).min(1).max(60).parse(raw),baseline=baselineSchema.parse(rawBaseline),conflicts:FieldConflict[]=[],result:Operation[]=[];
 validateOperationOrder(operations);let unresolved=false;
 const intended=new Map<string,RecordValue|null>(),last=new Map<string,number>();
 operations.forEach((op,i)=>{const {kind,id}=target(op),key=kind+':'+id,base=baseline.records.find(r=>r.kind===kind&&r.id===id);if(!base)throw new Error('编辑基线不完整，请重新打开记录。');const previous=intended.has(key)?intended.get(key):base.value;intended.set(key,op.type.endsWith('.delete')?null:{...previous,...op.data as RecordValue});if(op.unset)for(const field of op.unset)intended.get(key)![field]=undefined;last.set(key,i)});
 for(let i=0;i<operations.length;i++){
  const op=operations[i],{kind,id}=target(op),key=kind+':'+id;if(last.get(key)!==i)continue;
  const base=baseline.records.find(r=>r.kind===kind&&r.id===id)!.value,now=records(current,kind).find(r=>r.id===id)||null,wanted=intended.get(key)!;
  const conflict=(field:string,b:unknown,c:unknown,p:unknown)=>conflicts.push({kind,id,name:String(wanted?.name||now?.name||base?.name||id),field,base:b,current:c,proposed:p});
  if(wanted===null){
   if(!now)continue;
   const scope=deletionScope(current,kind,id),expected=baseline.deletions[key];
   if(!base||expected!==(expected?.startsWith('sha256:')?'sha256:'+fingerprint(scope):scope)){conflict('$delete',base,now,null);continue;}
   result.push({type:(kind+'.delete') as Operation['type'],id});continue;
  }
  if(!base){if(now){conflict('$record',null,now,wanted);continue;}result.push({type:(kind+'.save') as Operation['type'],data:wanted});continue;}
  if(!now){conflict('$record',base,null,wanted);continue;}
  const merged:RecordValue={...now};
  for(const field of Object.keys(wanted)){
   if(field==='id'||field==='updatedAt'||same(wanted[field],base[field]))continue;
   if(!same(now[field],base[field])&&!same(now[field],wanted[field])){conflict(field,base[field],now[field],wanted[field]);const chosen=typeof resolution==='string'?resolution:resolution?.[kind+':'+id+':'+field]||resolution?.[field];if(chosen!=='mine'&&chosen!=='theirs')unresolved=true;if(chosen==='theirs')continue;}
   merged[field]=wanted[field];
  }
  result.push({type:(kind+'.save') as Operation['type'],data:merged,unset:Object.keys(merged).filter(k=>merged[k]===undefined)});
 }
 if(conflicts.length&&(unresolved||!resolution||conflicts.some(c=>c.field.startsWith('$'))))throw new ChangeConflict(conflicts);
 if(result.length)try{applyOperations(current,result,'validate-merge')}catch(e){throw new MergeValidationError(e instanceof Error?e.message:'合并后的安排需要检查。',result)}
 return result;
}
export const fieldLabels:Record<string,string>={name:'名称',goal:'目标',start:'开始时间',end:'结束时间',status:'状态',shortName:'简称',description:'具体内容',result:'推进记录',hours:'预计投入',owner:'负责人',dependencies:'前置事项',contactId:'联系人',projectId:'所属项目',taskId:'关联事项',roles:'项目职责',notes:'备注',wechat:'联系方式',device:'电脑',path:'工程路径',purpose:'用途',done:'完成状态',fixed:'固定安排',priority:'优先级',deadline:'硬截止日期',remainingHours:'剩余投入',energy:'精力需求',dueAt:'下次跟进',blocksTask:'阻塞事项',reviewOn:'再次查看日期',followupId:'跟进记录',lastContactAt:'最近联系',resolvedAt:'解决时间',createdAt:'记录时间',$record:'整条记录',$delete:'删除及关联内容'};
