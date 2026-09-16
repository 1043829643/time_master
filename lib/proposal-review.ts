import {applyOperations,type Data,type Operation,type Block} from './domain.ts';
import {mergeChanges,type ChangeBaseline} from './changes.ts';

export type ReviewablePlan={id:string;operations:Operation[];baseline?:ChangeBaseline;workRevision:number;summary:string};
export function proposalData(data:Data,operations:Operation[]){return operations.length?applyOperations(data,operations,'preview-'+crypto.randomUUID()):data;}
export function proposalReferences(data:Data,operations:Operation[]){
 const result={projects:new Map(data.projects.map(v=>[v.id,v.name])),tasks:new Map(data.tasks.map(v=>[v.id,v.name])),contacts:new Map(data.contacts.map(v=>[v.id,v.name]))};
 for(const op of operations){const value=op.data as {id?:string;name?:string};const key=op.type==='project.save'?'projects':op.type==='task.save'?'tasks':op.type==='contact.save'?'contacts':null;if(key&&value?.id&&value.name)result[key].set(value.id,value.name);}
 return result;
}
// Each proposal is evaluated against the same saved workspace; pending plans are not saved schedules.
export function pendingPlanWarnings(data:Data,plans:ReviewablePlan[],targets?:Set<string>){
 const warnings:Record<string,string[]>={};
 const append=(id:string,message:string)=>{if(!targets||targets.has(id)){const rows=warnings[id];if(rows.length<20&&!rows.includes(message))rows.push(message);else if(rows.length===20)rows.push('还有其他待确认方案需要核对。这里只列出前 20 条提示。');}};
 const previews: {plan:ReviewablePlan;blocks:Block[]}[]=[];
 for(const plan of plans){warnings[plan.id]=[];try{
  if(!plan.operations.some(o=>o.type==='block.save')||!plan.baseline&&plan.workRevision!==data.workRevision)continue;
  const ops=plan.baseline?mergeChanges(data,plan.operations,plan.baseline):plan.operations,after=proposalData(data,ops);
  previews.push({plan,blocks:after.blocks.filter(b=>{const old=data.blocks.find(v=>v.id===b.id);return !b.done&&(!old||old.done||old.start!==b.start||old.end!==b.end)})});
 }catch{/* Incompatible plans are displayed as blocked, not as occupied time. */}}
 for(let i=0;i<previews.length;i++)for(let j=i+1;j<previews.length;j++){
  const a=previews[i],b=previews[j];
  if(targets&&!targets.has(a.plan.id)&&!targets.has(b.plan.id))continue;
  for(const x of a.blocks)for(const y of b.blocks){
   if(x.id===y.id){if(x.start===y.start&&x.end===y.end)continue;const message='待确认方案对同一日程「'+x.name+'」提出了不同时间，请选择或重新整理。';append(a.plan.id,message);append(b.plan.id,message);}
   else if(x.start<y.end&&x.end>y.start){const message='若两份方案都应用：「'+x.name+'」（'+x.start.replace('T',' ')+'–'+x.end.slice(11)+'）与「'+y.name+'」（'+y.start.replace('T',' ')+'–'+y.end.slice(11)+'）时间重叠。';append(a.plan.id,message);append(b.plan.id,message);}
  }
 }
 for(const id of Object.keys(warnings))warnings[id]=[...new Set(warnings[id])];
 return warnings;
}
export function pendingContext(data:Data,plans:ReviewablePlan[],budget=12000){
 const included:{summary:string;operations:Operation[];stale:boolean}[]=[];let length=0;
 for(const p of plans){let stale=false;try{if(p.baseline)mergeChanges(data,p.operations,p.baseline);else stale=p.workRevision!==data.workRevision}catch{stale=true}
  const value={summary:p.summary,operations:p.operations,stale},size=JSON.stringify(value).length;if(length+size>budget)continue;included.push(value);length+=size;
 }
 return {pendingProposals:included,pendingProposalCount:plans.length,omittedPendingCount:plans.length-included.length};
}
