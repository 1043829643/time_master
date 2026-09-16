import {applyOperations,daysBetween,localDay,addDays,type Data,type Operation,type Task,type Block} from './domain.ts';

export function taskBlockers(data:Data,task:Task):string[]{
 const project=data.projects.find(p=>p.id===task.projectId),reasons:string[]=[];
 if(project?.status==='paused')reasons.push('所属项目已暂停');
 if(project?.status==='done')reasons.push('所属项目已完成');
 if(task.status==='paused')reasons.push('事项已暂停');
 if(task.status==='waiting')reasons.push('事项正在等待跟进');
 for(const f of data.followups||[])if(f.status==='waiting'&&f.blocksTask&&f.taskId===task.id)reasons.push('等待：'+f.name);
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
 return calendarConflicts(data,after);
}
export function calendarConflicts(data:Data,after:Data,limit=51){
 const changed=new Set(after.blocks.filter(b=>{const old=data.blocks.find(o=>o.id===b.id);return !old||old.start!==b.start||old.end!==b.end||old.done!==b.done}).map(b=>b.id));
 const active=after.blocks.filter(b=>!b.done).sort((a,b)=>a.start.localeCompare(b.start));
 const pairs:{a:Block;b:Block}[]=[];
 for(let i=0;i<active.length;i++)for(let j=i+1;j<active.length&&active[j].start<active[i].end;j++)if(changed.has(active[i].id)||changed.has(active[j].id)){pairs.push({a:active[i],b:active[j]});if(pairs.length>=limit)return pairs;}
 return pairs;
}
export function blockRisks(data:Data,block:Block):string[]{
 if(block.done||!block.taskId)return [];
 const task=data.tasks.find(t=>t.id===block.taskId);if(!task)return [];
 const reasons=taskBlockers(data,task);
 if(block.start.slice(0,10)<task.start)reasons.push('早于事项预计开始：'+task.start+'，请核对是否需要改期');
 if(block.end>addDays(task.end,1)+'T00:00')reasons.push('超出事项预计结束：'+task.end+'，请核对是否需要改期');
 const deadline=task.deadlineAt||(task.deadline?addDays(task.deadline,1)+'T00:00':'');if(deadline&&block.end>deadline)reasons.push('超出硬截止：'+(task.deadlineAt||task.deadline)+'，需要调整安排');
 if(task.status==='done')reasons.push('关联事项已完成，可释放这段预留时间');
 const late=task.dependencies.map(id=>data.tasks.find(t=>t.id===id)).filter(t=>t&&t.status!=='done'&&t.end>=block.start.slice(0,10));
 if(late.length)reasons.push('前置预计完成晚于本时段：'+late.map(t=>t!.name+'（'+t!.end+'）').join('、'));
 return reasons;
}
export function releasableBlocks(data:Data,taskId?:string){return data.blocks.filter(b=>!b.done&&b.start>=localDay()+'T00:00'&&(!taskId||b.taskId===taskId)&&data.tasks.some(t=>t.id===b.taskId&&(t.status==='done'||data.projects.some(p=>p.id===t.projectId&&p.status==='done'))));}
export type ChangeWarning={code:string;message:string};
export function describeChanges(data:Data,operations:Operation[],limit=300){
 const names={project:'项目',task:'事项',block:'日程',contact:'联系人',resource:'工程位置',capture:'随手记',followup:'跟进'};
 const labels:Record<string,string>={shortName:'简称',owner:'负责人',start:'开始',end:'结束',status:'状态',goal:'目标',description:'内容',notes:'备注',result:'推进记录',remainingHours:'剩余小时',hours:'预计小时',deadline:'截止日期',deadlineAt:'截止时刻',priority:'优先级',energy:'精力',reviewOn:'再次查看',dueAt:'下次跟进',device:'电脑',path:'路径',purpose:'用途',wechat:'微信',roles:'职责',dependencies:'前置条件',blocksTask:'阻塞事项',done:'完成',fixed:'固定'};
 const values:Record<string,string>={todo:'待开始',doing:'进行中',waiting:'等待',done:'完成',paused:'暂停',active:'推进中',archived:'已归档',converted:'已整理',inbox:'待整理',resolved:'已解决',cancelled:'已取消',high:'重要',normal:'普通',low:'较低',focus:'专注',light:'轻量'};
 const lines=operations.map(op=>{const kind=op.type.split('.')[0] as keyof typeof names,v=op.data as any,collection=kind==='project'?data.projects:kind==='task'?data.tasks:kind==='block'?data.blocks:kind==='contact'?data.contacts:kind==='capture'?data.captures:kind==='followup'?data.followups:data.resources,old=collection.find(x=>x.id===(op.id||v?.id)) as any;const changes=Object.entries(v||{}).filter(([k,value])=>!['start','end'].includes(k)&&labels[k]&&JSON.stringify(value)!==JSON.stringify(old?.[k])&&(!!old||value!==''&&value!==false&&(!Array.isArray(value)||value.length>0)&&!['todo','active'].includes(String(value)))).map(([k,value])=>labels[k]+'：'+(typeof value==='boolean'?value?'是':'否':Array.isArray(value)?value.map(x=>typeof x==='object'?x.role:x).join('、')||'无':value===''?'未设置':values[String(value)]||String(value).replace('T',' ')));if(v&&(v.start&&v.start!==old?.start||v.end&&v.end!==old?.end))changes.unshift(String(v.start||old?.start||'未定').replace('T',' ')+' → '+String(v.end||old?.end||'未定').replace('T',' '));return (op.type.endsWith('.delete')?'删除':old?'更新':'新增')+names[kind]+'「'+(v?.name||old?.name||'记录')+'」'+(changes.length?'，'+changes.join('，'):'');});
 return (lines.join('；')+'。').slice(0,limit);
}
export function changeWarnings(data:Data,operations:Operation[]):ChangeWarning[]{
 if(!operations.length)return [];
 return warningsForChange(data,applyOperations(data,operations,'review-changes'),operations);
}
export function warningsForChange(data:Data,after:Data,operations:Operation[]=[]):ChangeWarning[]{
 const warnings:ChangeWarning[]=[];
 const overlaps=calendarConflicts(data,after);
 for(const pair of overlaps.slice(0,50))warnings.push({code:'overlap',message:'时间重叠：'+pair.a.name+'（'+pair.a.start.replace('T',' ')+'–'+pair.a.end.slice(11)+'）与 '+pair.b.name+'（'+pair.b.start.replace('T',' ')+'–'+pair.b.end.slice(11)+'）'});
 if(overlaps.length>50)warnings.push({code:'overlap-limit',message:'重叠日程较多，这里只列出前 50 组。请在日历中继续核对，或分开恢复。'});
 for(const op of operations){
  const value=op.data as any;
   if(op.type.endsWith('.delete'))warnings.push({code:'delete',message:describeChanges(data,[op])+(op.type==='project.delete'?'其事项、未完成且未固定的日程和工程记录也会删除；已完成和固定日程保留为独立记录，电脑文件不受影响。':op.type==='task.delete'?'未完成且未固定的关联日程会删除；已完成和固定日程保留为独立记录，其他事项解除对它的依赖。':op.type==='contact.delete'?'事项和日程中的联系人关联也会解除。':'')});
  if(op.type==='block.save'||op.type==='block.delete'){
   const previous=data.blocks.find(b=>b.id===(op.id||value?.id)),next=after.blocks.find(b=>b.id===previous?.id);
   if(previous?.fixed&&(!next||next.start!==previous.start||next.end!==previous.end||!next.fixed))warnings.push({code:'fixed',message:'将调整固定安排「'+previous.name+'」，请确认时间已经协商。'});
  }
 }
 for(const previous of data.blocks.filter(b=>b.fixed&&b.taskId)){
  const next=after.blocks.find(b=>b.id===previous.id);
  if(next&&!next.taskId)warnings.push({code:'fixed-retained',message:'固定安排「'+previous.name+'」'+previous.start.replace('T',' ')+' 将保留为独立日程。'});
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
export function visibleTaskPosition(start:string,task:Pick<Task,'start'|'end'>,cell:number,total:number,scroll=0,viewport=Infinity){
 const actual=taskPosition(start,task,cell),left=Math.max(actual.left,0,scroll),end=Math.min(actual.left+actual.width,total*cell,scroll+viewport);
 return {left,width:Math.max(0,end-left),before:actual.left<left,after:actual.left+actual.width>end};
}
