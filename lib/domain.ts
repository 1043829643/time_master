import {z} from 'zod';
const id=z.string().min(1).max(100),name=z.string().trim().min(1).max(160),note=z.string().max(8000).default('');
export const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T12:00:00Z');return !isNaN(+d)&&d.toISOString().slice(0,10)===v},'日期无效');
const status=z.enum(['todo','doing','waiting','done','paused']);
export const projectSchema=z.object({id,name,goal:note,status:z.enum(['active','paused','done']).default('active'),start:day,end:day,color:z.enum(['green','blue','amber']).default('green')});
export const taskSchema=z.object({id,projectId:id,name,shortName:z.string().max(20).default(''),description:note,start:day,end:day,status:status.default('todo'),owner:z.string().max(100).default('我'),hours:z.number().min(0).max(10000).default(1),dependencies:z.array(id).max(40).default([]),contactId:z.string().max(100).default(''),updatedAt:z.string().default(''),result:note});
export const blockSchema=z.object({id,taskId:z.string().max(100).default(''),name,start:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),end:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),fixed:z.boolean().default(false),done:z.boolean().default(false)});
export const contactSchema=z.object({id,name,wechat:z.string().max(150).default(''),notes:note,roles:z.array(z.object({projectId:id,role:z.string().max(300)})).max(100).default([])});
export const resourceSchema=z.object({id,projectId:id,name,device:z.string().max(160).default(''),path:z.string().max(2000),purpose:note});
export const messageSchema=z.object({id,role:z.enum(['user','assistant']),content:z.string().max(16000),at:z.string()});
export const dataSchema=z.object({workRevision:z.number().int().min(0).default(0),projects:z.array(projectSchema).max(100),tasks:z.array(taskSchema).max(1500),blocks:z.array(blockSchema).max(2000),contacts:z.array(contactSchema).max(500),resources:z.array(resourceSchema).max(1000),messages:z.array(messageSchema).max(80),appliedIds:z.array(z.string()).max(100),history:z.array(z.object({at:z.string(),summary:z.string()})).max(80)});
export type Project=z.infer<typeof projectSchema>;export type Task=z.infer<typeof taskSchema>;export type Block=z.infer<typeof blockSchema>;export type Contact=z.infer<typeof contactSchema>;export type Resource=z.infer<typeof resourceSchema>;export type Data=z.infer<typeof dataSchema>;
export type Snapshot={data:Data;revision:number};
export type Operation={type:'project.save'|'project.delete'|'task.save'|'task.delete'|'block.save'|'block.delete'|'contact.save'|'contact.delete'|'resource.save'|'resource.delete'|'message.add';data?:unknown;id?:string};
export const operationSchema=z.object({type:z.enum(['project.save','project.delete','task.save','task.delete','block.save','block.delete','contact.save','contact.delete','resource.save','resource.delete','message.add']),data:z.unknown().optional(),id:z.string().optional()}).superRefine((op,ctx)=>{if(op.type.endsWith('.save')&&op.id&&op.id!==(op.data as {id?:string})?.id)ctx.addIssue({code:z.ZodIssueCode.custom,message:'保存操作的记录编号不一致。'});});
export function validateOperationOrder(ops:Operation[]){const actions=new Map<string,string>(),hasDelete=ops.some(op=>op.type.endsWith('.delete'));for(const op of ops){if(op.type==='message.add')continue;const [kind,action]=op.type.split('.'),id=action==='save'?(op.data as {id?:string})?.id:op.id,key=kind+':'+id,previous=actions.get(key);if(previous&&(previous==='delete'||action==='delete'))throw new Error('同一批次不能反复删除或同时删除和重建同一记录，请分开处理。');if(previous&&hasDelete)throw new Error('含删除的批次不能反复修改同一记录，请合并修改后再删除，或分开处理。');actions.set(key,action);}}
export function emptyData():Data{return {workRevision:0,projects:[],tasks:[],blocks:[],contacts:[],resources:[],messages:[],appliedIds:[],history:[]};}
export function localDay(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
export function addDays(date:string,n:number){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
export function daysBetween(a:string,b:string){return Math.round((+new Date(b+'T12:00:00Z')-+new Date(a+'T12:00:00Z'))/86400000);}
export function validateData(input:unknown):Data{
 const d=dataSchema.parse(input);for(const list of [d.projects,d.tasks,d.blocks,d.contacts,d.resources]){if(new Set(list.map(v=>v.id)).size!==list.length)throw new Error('存在重复编号，请重新加载后再保存。');}
 const projects=new Set(d.projects.map(p=>p.id)),tasks=new Map(d.tasks.map(t=>[t.id,t])),contacts=new Set(d.contacts.map(c=>c.id));
 for(const p of d.projects)if(p.start>p.end)throw new Error('项目结束日期不能早于开始日期。');
 for(const t of d.tasks){if(!projects.has(t.projectId))throw new Error('任务所属项目不存在。');if(t.start>t.end)throw new Error('任务结束日期不能早于开始日期。');if(t.contactId&&!contacts.has(t.contactId))throw new Error('关联联系人不存在。');for(const dep of t.dependencies)if(!tasks.has(dep)||dep===t.id)throw new Error('任务依赖不存在，或指向任务自身。');}
 const visited=new Set<string>(),visiting=new Set<string>();const visit=(key:string)=>{if(visiting.has(key))throw new Error('依赖形成循环，请检查前置任务。');if(visited.has(key))return;visiting.add(key);tasks.get(key)!.dependencies.forEach(visit);visiting.delete(key);visited.add(key);};d.tasks.forEach(t=>visit(t.id));
 for(const b of d.blocks){if(!day.safeParse(b.start.slice(0,10)).success||!day.safeParse(b.end.slice(0,10)).success||!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.start.slice(11))||!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.end.slice(11))||b.start>=b.end)throw new Error('日程的起止时间无效。');if(b.taskId&&!tasks.has(b.taskId))throw new Error('日程关联的任务不存在。');}
 for(const c of d.contacts)for(const r of c.roles)if(!projects.has(r.projectId))throw new Error('联系人关联的项目不存在。');
 for(const r of d.resources)if(!projects.has(r.projectId))throw new Error('工程所属项目不存在。');
 return d;
}
export function applyOperations(current:Data,raw:unknown,operationId:string,summary='更新工作空间'):Data{
 const ops=structuredClone(z.array(operationSchema).min(1).max(60).parse(raw));validateOperationOrder(ops);const d=structuredClone(current);if(d.appliedIds.includes(operationId))return d;
 const upsert=(list:any[],value:any)=>{const i=list.findIndex(x=>x.id===value.id);if(i<0)list.push(value);else list[i]=value;};
 const removeTask=(taskId:string)=>{d.tasks=d.tasks.filter(t=>t.id!==taskId).map(t=>({...t,dependencies:t.dependencies.filter(x=>x!==taskId)}));d.blocks=d.blocks.filter(b=>b.taskId!==taskId||b.done).map(b=>b.taskId===taskId?{...b,taskId:''}:b);};
 for(const op of ops){const kind=op.type.split('.')[0];const list=kind==='project'?d.projects:kind==='task'?d.tasks:kind==='block'?d.blocks:kind==='contact'?d.contacts:d.resources;if(op.type.endsWith('.delete')&&(!op.id||!list.some(v=>v.id===op.id)))throw new Error('要删除的记录不存在，请刷新后核对。');if(op.type.endsWith('.save')&&op.data&&typeof op.data==='object'){const input=op.data as {id?:string};const old=list.find(v=>v.id===input.id);if(old)op.data={...old,...input};}switch(op.type){case 'project.save':upsert(d.projects,projectSchema.parse(op.data));break;case 'task.save':upsert(d.tasks,{...taskSchema.parse(op.data),updatedAt:new Date().toISOString()});break;case 'block.save':upsert(d.blocks,blockSchema.parse(op.data));break;case 'contact.save':upsert(d.contacts,contactSchema.parse(op.data));break;case 'resource.save':upsert(d.resources,resourceSchema.parse(op.data));break;
 case 'project.delete':if(!op.id)throw new Error('缺少项目编号');d.tasks.filter(t=>t.projectId===op.id).forEach(t=>removeTask(t.id));d.projects=d.projects.filter(p=>p.id!==op.id);d.resources=d.resources.filter(r=>r.projectId!==op.id);d.contacts=d.contacts.map(c=>({...c,roles:c.roles.filter(r=>r.projectId!==op.id)}));break;
 case 'task.delete':if(!op.id)throw new Error('缺少任务编号');removeTask(op.id);break;
 case 'block.delete':d.blocks=d.blocks.filter(b=>b.id!==op.id);break;case 'resource.delete':d.resources=d.resources.filter(r=>r.id!==op.id);break;
 case 'contact.delete':d.contacts=d.contacts.filter(c=>c.id!==op.id);d.tasks=d.tasks.map(t=>t.contactId===op.id?{...t,contactId:''}:t);break;
 case 'message.add':d.messages.push(messageSchema.parse(op.data));d.messages=d.messages.slice(-80);break;}}
 if(ops.some(op=>op.type!=='message.add')){for(const t of d.tasks){const p=d.projects.find(p=>p.id===t.projectId);if(p){if(t.start<p.start)p.start=t.start;if(t.end>p.end)p.end=t.end;}}d.workRevision=(d.workRevision||0)+1;d.history=[...d.history,{at:new Date().toISOString(),summary:summary.slice(0,300)}].slice(-80);}validateData(d);d.appliedIds=[...d.appliedIds,operationId].slice(-100);return d;
}
export function collisions(d:Data,block:Block){return d.blocks.filter(b=>b.id!==block.id&&!b.done&&b.start<block.end&&b.end>block.start);}
export const statusLabels={todo:'待开始',doing:'进行中',waiting:'等待',done:'已完成',paused:'暂停'};
