import {applyOperations,daysBetween,localDay,type Data,type Operation,type Task,type Block} from './domain.ts';

export function taskBlockers(data:Data,task:Task):string[]{
 const project=data.projects.find(p=>p.id===task.projectId),reasons:string[]=[];
 if(project?.status==='paused')reasons.push('所属项目已暂停');
 if(project?.status==='done')reasons.push('所属项目已完成');
 if(task.status==='paused')reasons.push('事项已暂停');
 if(task.status==='waiting')reasons.push('事项正在等待跟进');
 const pending=task.dependencies.map(id=>data.tasks.find(t=>t.id===id)).filter(t=>t&&t.status!=='done');
 if(pending.length)reasons.push('等待前置：'+pending.map(t=>t!.name).join('、'));
 return reasons;
}
export function dayCandidates(data:Data,date:string){
 const candidates=data.tasks.filter(t=>t.status!=='done'&&t.start<=date).sort((a,b)=>a.end.localeCompare(b.end)||a.name.localeCompare(b.name));
 return {ready:candidates.filter(t=>!taskBlockers(data,t).length),blocked:candidates.filter(t=>taskBlockers(data,t).length)};
}
export function proposalConflicts(data:Data,operations:Operation[]){
 if(!operations.length)return [];
 const after=applyOperations(data,operations,'preview-conflicts');
 const changed=new Set(after.blocks.filter(b=>{const old=data.blocks.find(o=>o.id===b.id);return !old||old.start!==b.start||old.end!==b.end||old.done!==b.done}).map(b=>b.id));
 const active=after.blocks.filter(b=>!b.done).sort((a,b)=>a.start.localeCompare(b.start));
 const pairs:{a:Block;b:Block}[]=[];
 for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length&&active[j].start<active[i].end;j++)if(changed.has(active[i].id)||changed.has(active[j].id))pairs.push({a:active[i],b:active[j]});
 return pairs;
}
export function blockRisks(data:Data,block:Block):string[]{
 if(block.done||!block.taskId)return [];
 const task=data.tasks.find(t=>t.id===block.taskId);if(!task)return [];
 const reasons=taskBlockers(data,task);
 if(task.status==='done')reasons.push('关联事项已完成，可释放这段预留时间');
 const late=task.dependencies.map(id=>data.tasks.find(t=>t.id===id)).filter(t=>t&&t.status!=='done'&&t.end>=block.start.slice(0,10));
 if(late.length)reasons.push('前置预计完成晚于本时段：'+late.map(t=>t!.name+'（'+t!.end+'）').join('、'));
 return reasons;
}
export function releasableBlocks(data:Data,taskId?:string){return data.blocks.filter(b=>!b.done&&b.start>=localDay()+'T00:00'&&(!taskId||b.taskId===taskId)&&data.tasks.some(t=>t.id===b.taskId&&(t.status==='done'||data.projects.some(p=>p.id===t.projectId&&p.status==='done'))));}
export type ChangeWarning={code:string;message:string};
export function describeChanges(data:Data,operations:Operation[]){
 const names={project:'项目',task:'事项',block:'日程',contact:'联系人',resource:'工程位置'};
 const lines=operations.slice(0,4).map(op=>{const kind=op.type.split('.')[0] as keyof typeof names,v=op.data as any,collection=kind==='project'?data.projects:kind==='task'?data.tasks:kind==='block'?data.blocks:kind==='contact'?data.contacts:data.resources,old=collection.find(x=>x.id===(op.id||v?.id));return (op.type.endsWith('.delete')?'删除':old?'更新':'新增')+names[kind]+'「'+(v?.name||old?.name||'记录')+'」'+(v?.start||v?.end?'：'+String(v.start||((old as any)?.start)||'未定').replace('T',' ')+' → '+String(v.end||((old as any)?.end)||'未定').replace('T',' '):'');});
 return (lines.join('；')+(operations.length>4?'；另有 '+(operations.length-4)+' 项变更。':'。')).slice(0,300);
}
export function changeWarnings(data:Data,operations:Operation[]):ChangeWarning[]{
 if(!operations.length)return [];
 const after=applyOperations(data,operations,'review-changes'),warnings:ChangeWarning[]=[];
 for(const pair of proposalConflicts(data,operations))warnings.push({code:'overlap',message:'时间重叠：'+pair.a.name+'（'+pair.a.start.replace('T',' ')+'–'+pair.a.end.slice(11)+'）与 '+pair.b.name+'（'+pair.b.start.replace('T',' ')+'–'+pair.b.end.slice(11)+'）'});
 for(const op of operations){
  const value=op.data as any;
  if(op.type.endsWith('.delete'))warnings.push({code:'delete',message:describeChanges(data,[op])+(op.type==='project.delete'?'其事项、未完成日程和工程记录也会删除；已完成日程保留，电脑文件不受影响。':op.type==='task.delete'?'关联未完成日程会删除，其他事项解除对它的依赖。':op.type==='contact.delete'?'事项中的联系人关联也会解除。':'')});
  if(op.type==='block.save'||op.type==='block.delete'){
   const previous=data.blocks.find(b=>b.id===(op.id||value?.id)),next=after.blocks.find(b=>b.id===previous?.id);
   if(previous?.fixed&&(!next||next.start!==previous.start||next.end!==previous.end||!next.fixed))warnings.push({code:'fixed',message:'将调整固定安排「'+previous.name+'」，请确认时间已经协商。'});
  }
 }
 for(const b of after.blocks){
  const old=data.blocks.find(x=>x.id===b.id),previous=old?blockRisks(data,old):[];
  const added=blockRisks(after,b).filter(r=>!previous.includes(r));
  if(added.length)warnings.push({code:'dependency',message:'「'+b.name+'」'+b.start.replace('T',' ')+'：'+added.join('；')});
 }
 return warnings;
}
// Keep a true scale, with horizontal scrolling instead of shrinking short tasks.
export function timelineCell(available:number,total:number){return Math.max(112,Math.min(168,Math.max(600,available-210)/Math.max(1,total)));}
export function taskPosition(start:string,task:Pick<Task,'start'|'end'>,cell:number){return {left:daysBetween(start,task.start)*cell+3,width:(daysBetween(task.start,task.end)+1)*cell-6};}
