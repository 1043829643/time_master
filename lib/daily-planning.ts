import {z} from 'zod';
import {day,localDay,type Data,type Operation,type Capture,type Followup,type Block} from './domain.ts';
import {taskBlockers} from './planning.ts';
import {constraintViolations,type ConversationMemory} from './conversation-memory.ts';

const clock=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const dayPlanSchema=z.object({date:day,start:clock,end:clock,minutes:z.number().int().min(15).max(480),energy:z.enum(['focus','light']).default('focus')});
export type DayPlanInput=z.infer<typeof dayPlanSchema>;
const minute=(s:string)=>Number(s.slice(0,2))*60+Number(s.slice(3,5));
const hhmm=(m:number)=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
const stamp=(s:string)=>Date.parse(s+'+08:00');
export function beijingNow(now=new Date()){return new Date(now.getTime()+8*3600000).toISOString().slice(0,16);}
export function makeDayPlan(data:Data,input:DayPlanInput,memories:ConversationMemory[],requestId:string,now=beijingNow()){
 const p=dayPlanSchema.parse(input);if(p.date<now.slice(0,10))throw new Error('请选择今天或以后的日期。');
 let cursor=minute(p.start);const end=minute(p.end);if(cursor>=end)throw new Error('可用时段的结束时间要晚于开始时间。');
 if(p.date===now.slice(0,10))cursor=Math.max(cursor,Math.ceil(minute(now.slice(11))/15)*15);
 const windowStart=cursor;
 const busy=data.blocks.filter(b=>b.start<p.date+'T'+p.end&&b.end>p.date+'T'+p.start);
 const rank=(t:Data['tasks'][number])=>(t.deadline&&t.deadline<=p.date?1000:0)+(t.priority==='high'?300:t.priority==='low'?0:100)+(t.status==='doing'?30:0)+(t.deadline?20:0);
 const tasks=data.tasks.filter(t=>t.start<=p.date&&!taskBlockers(data,t).length&&t.status!=='done'&&(p.energy==='focus'||t.energy==='light')).sort((a,b)=>rank(b)-rank(a)||(a.deadline||a.end).localeCompare(b.deadline||b.end)||a.name.localeCompare(b.name));
 const operations:Operation[]=[],items:{taskId:string;name:string;start:string;end:string;minutes:number;reason:string}[]=[];
 const reserved=new Map<string,number>();for(const b of data.blocks)if(!b.done&&b.taskId&&b.end>now)reserved.set(b.taskId,(reserved.get(b.taskId)||0)+(stamp(b.end)-Math.max(stamp(b.start),stamp(now)))/60000);
 let budget=p.minutes;
 for(const t of tasks){
  cursor=windowStart;
  let remaining=Math.max(0,Math.round((t.remainingHours??t.hours)*60)-(reserved.get(t.id)||0));
  while(remaining>=15&&budget>=15&&cursor+15<=end&&items.length<12){
   const start=p.date+'T'+hhmm(cursor),overlap=busy.find(b=>b.start< p.date+'T'+hhmm(cursor+15)&&b.end>start);
   if(overlap){cursor=Math.ceil(Math.max(cursor+1,(stamp(overlap.end)-stamp(p.date+'T00:00'))/60000)/15)*15;continue;}
   const nextBusy=busy.filter(b=>b.start>=start).map(b=>minute(b.start.slice(11))).sort((a,b)=>a-b)[0]??end;
   let duration=Math.floor(Math.min(60,remaining,budget,end-cursor,nextBusy-cursor)/15)*15;
   let op:Operation|undefined;
   while(duration>=15){const candidate:Operation={type:'block.save',data:{id:requestId+'-slot-'+items.length,taskId:t.id,name:t.name,start,end:p.date+'T'+hhmm(cursor+duration),fixed:false,done:false}};if(!constraintViolations(data,[...operations,candidate],memories).length){op=candidate;break}duration-=15;}
   if(!op){cursor+=15;continue;}
   operations.push(op);busy.push(op.data as Block);items.push({taskId:t.id,name:t.name,start,end:p.date+'T'+hhmm(cursor+duration),minutes:duration,reason:[t.deadline?'硬截止 '+t.deadline:'预计 '+t.end+' 前推进',t.priority==='high'?'重要事项':t.status==='doing'?'接着推进':'可以开始',t.energy==='light'?'轻量处理':'需要专注'].join(' · ')});remaining-=duration;budget-=duration;cursor+=duration;
  }
 }
 const planned=p.minutes-budget;
 return {items,operations,plannedMinutes:planned,unfilledMinutes:budget,blockedCount:data.tasks.filter(t=>t.status!=='done'&&taskBlockers(data,t).length).length,explanation:items.length?`安排了 ${planned} 分钟，保留现有日程。${budget?'还有 '+budget+' 分钟没有找到符合时段、精力与限制的事项。':''}`:'暂时没有可放入这段时间的事项。检查等待条件、剩余投入、已排时间，或换一个时段。'};
}
export function convertCapture(data:Data,capture:Capture,input:{projectId:string;start:string;end:string;hours:number},taskId:string):Operation[]{
 if(capture.status!=='inbox')throw new Error('这条随手记已经整理过了。');
 return [{type:'task.save',data:{id:taskId,projectId:input.projectId,name:capture.name,shortName:'',description:capture.notes,start:input.start,end:input.end,status:'todo',owner:'我',hours:input.hours,remainingHours:input.hours,priority:'normal',dependencies:[],contactId:'',updatedAt:'',result:''}},{type:'capture.save',data:{...capture,status:'converted',taskId,projectId:input.projectId,followupId:'',reviewOn:''}}];
}
export function completeFollowup(f:Followup):Operation[]{return [{type:'followup.save',data:{...f,status:'resolved',resolvedAt:new Date().toISOString()}}];}
export function followupDue(f:Followup,now=beijingNow()){return f.status==='waiting'&&f.dueAt<=now;}
export function reviewCounts(data:Data,date=localDay()){return {done:data.blocks.filter(b=>b.done&&b.start.slice(0,10)===date).length,unfinished:data.blocks.filter(b=>!b.done&&b.end<date+'T23:59'&&b.start.slice(0,10)===date).length,inbox:data.captures.filter(c=>c.status==='inbox'&&(!c.reviewOn||c.reviewOn<=date)).length,followups:data.followups.filter(f=>f.status==='waiting'&&f.dueAt.slice(0,10)<=date).length};}
