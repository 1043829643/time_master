import {applyOperations,daysBetween,type Data,type Operation,type Task,type Block} from './domain.ts';

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
 const after=applyOperations(data,operations,'preview-conflicts');
 const changed=new Set(after.blocks.filter(b=>{const old=data.blocks.find(o=>o.id===b.id);return !old||old.start!==b.start||old.end!==b.end||old.done!==b.done}).map(b=>b.id));
 const active=after.blocks.filter(b=>!b.done).sort((a,b)=>a.start.localeCompare(b.start));
 const pairs:{a:Block;b:Block}[]=[];
 for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length&&active[j].start<active[i].end;j++)if(changed.has(active[i].id)||changed.has(active[j].id))pairs.push({a:active[i],b:active[j]});
 return pairs;
}
// Keep a true scale, with horizontal scrolling instead of shrinking short tasks.
export function timelineCell(available:number,total:number){return Math.max(112,Math.min(168,Math.max(600,available-210)/Math.max(1,total)));}
export function taskPosition(start:string,task:Pick<Task,'start'|'end'>,cell:number){return {left:daysBetween(start,task.start)*cell+3,width:(daysBetween(task.start,task.end)+1)*cell-6};}
