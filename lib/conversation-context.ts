import {addDays,type Data,type Operation} from './domain.ts';
import {relativeDate} from './conversation-dates.ts';

export const CHAT_CONTEXT_LIMIT=96000;
export const CHAT_REVIEW_RESERVE=24000;
export const CHAT_REVIEW_CANDIDATE_LIMIT=16000;
const keys=['projects','tasks','blocks','contacts','resources','captures','followups'] as const;
type Collection=typeof keys[number];
type Workspace=Pick<Data,Collection|'workRevision'>;
type ContextWorkspace=Workspace&{coverage:{mode:'complete'|'scoped';omitted?:Partial<Record<Collection,number>>;note?:string}};
const collections:Record<string,Collection>={project:'projects',task:'tasks',block:'blocks',contact:'contacts',resource:'resources',capture:'captures',followup:'followups'};

export class ContextTooLargeError extends Error {
 constructor(message='工作空间内容较多，请指明具体项目、事项或联系人后再试。'){super(message);this.name='ContextTooLargeError'}
}

const recordKey=(kind:string,id:string)=>kind+':'+id;
const normalize=(value:string)=>value.replace(/\s+/g,'').toLocaleLowerCase('zh-CN');
const named=(normalizedText:string,value:{id:string;name:string;shortName?:string;wechat?:string})=>
 [value.name,value.shortName,value.wechat,value.id.length>=6?value.id:''].some(name=>!!name&&normalize(name).length>=2&&normalizedText.includes(normalize(name)));
const likelyNew=(text:string)=>/新建|新增|创建|添加|先记|记下|记住|记录一下|帮我记|安排.{0,12}(?:会议|日程)/.test(text);
const socialOnly=(text:string)=>/^(?:你好|嗨|哈喽|早安|晚安|谢谢|我(?:今天|最近)?(?:有点|很)(?:累|烦|焦虑|开心))[^项目事项任务日程会议跟进工作]*[。！!？?]?$/.test(text.trim());

function requestedDates(text:string,today:string){
 const dates=new Set([...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(m=>m[0]));
 for(const date of dates){const parsed=new Date(date+'T12:00:00Z');if(isNaN(+parsed)||parsed.toISOString().slice(0,10)!==date)throw new ContextTooLargeError('日期似乎无效，请写明正确的年月日。')}
 const relative=relativeDate(text,today);if(relative)dates.add(relative);
 for(const match of text.matchAll(/(?:(\d{4})年|(今年|明年|去年))?(\d{1,2})月(\d{1,2})(?:日|号)?/g)){
  const year=match[1]?Number(match[1]):Number(today.slice(0,4))+(match[2]==='明年'?1:match[2]==='去年'?-1:0);
  const month=Number(match[3]),day=Number(match[4]),date=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  const parsed=new Date(Date.UTC(year,month-1,day));
  if(parsed.toISOString().slice(0,10)!==date)throw new ContextTooLargeError('日期似乎无效，请写明正确的年月日。');
  if(!match[1]&&!match[2]&&date<today)throw new ContextTooLargeError('这个月日可能指今年或明年，请补充年份后再查询。');
  dates.add(date);
 }
 return dates;
}

function basic(data:Data):Workspace{
 return {workRevision:data.workRevision,projects:data.projects,tasks:data.tasks,blocks:data.blocks,contacts:data.contacts,resources:data.resources,captures:data.captures,followups:data.followups};
}

export function recentConversation(messages:Data['messages'],budget=14000){
 const selected:Data['messages']=[];let size=0;
 for(let i=messages.length-1;i>=0;i--){const next=messages[i],cost=next.content.length+96;if(size+cost>budget)break;selected.unshift(next);size+=cost}
 return selected;
}

export function recentUnfinished<T extends {request_id:string;request_text:string;state:string}>(requests:T[],currentId:string,budget=10000){
 const failed=requests.filter(r=>r.request_id!==currentId&&r.state==='failed');
 const included:T[]=[];let size=0;
 for(let i=failed.length-1;i>=0;i--){const next=failed[i],cost=next.request_text.length+120;if(size+cost>budget)break;included.unshift(next);size+=cost}
 return {included,omittedCount:failed.length-included.length};
}

export function reviewCandidate(candidate:unknown){
 const encoded=JSON.stringify(candidate)??'null';
 return encoded.length<=CHAT_REVIEW_CANDIDATE_LIMIT?encoded:'候选答复超过可核对长度，未附全文。请根据用户本轮原话和权威工作空间重新独立生成。';
}

export function assertConversationPromptBudget(messages:unknown[],reserve=0){
 if(JSON.stringify(messages).length>CHAT_CONTEXT_LIMIT-reserve)throw new ContextTooLargeError('这轮相关信息过多，请缩小到一个项目、事项或更短的时间段。');
}

export function conversationWorkspace(data:Data,text:string,budget:number,today:string){
 const full=basic(data),fullContext:ContextWorkspace={...full,coverage:{mode:'complete'}};
 if(JSON.stringify(fullContext).length<=budget)return {context:fullContext,visible:null as Set<string>|null,editable:null as Set<string>|null};
 if(budget<3000)throw new ContextTooLargeError('当前待确认内容和对话记录过多，请先处理待确认方案，或缩短本轮输入。');

 const chosen:Record<Collection,Set<string>>=Object.fromEntries(keys.map(k=>[k,new Set<string>()])) as Record<Collection,Set<string>>;
 const add=(collection:Collection,id:string|undefined)=>{if(id)chosen[collection].add(id)};
 const explicit=new Set<string>(),normalizedText=normalize(text);
 for(const collection of keys)for(const value of data[collection])if(named(normalizedText,value)){
  add(collection,value.id);explicit.add(recordKey(collection,value.id));
 }
 const dates=requestedDates(text,today);
 const dateScheduleRead=dates.size>0&&/(日程|会议|安排|行程)/.test(text)&&/(哪些|有什么|看|查|列|几|几点)/.test(text)&&!/(能做|可做|优先|待办|事项|任务)/.test(text);
 if(!explicit.size&&!likelyNew(text)&&!socialOnly(text)&&!dateScheduleRead)throw new ContextTooLargeError();

 // A named project means its entire current project area, including parallel work.
 const explicitProjects=new Set(data.projects.filter(p=>explicit.has(recordKey('projects',p.id))).map(p=>p.id));
 const editable=new Set(explicit);
 for(const projectId of explicitProjects){
  for(const t of data.tasks)if(t.projectId===projectId){add('tasks',t.id);if(/(?:所有|全部|每个|项目下).{0,8}(?:事项|任务)/.test(text))editable.add(recordKey('tasks',t.id))}
  for(const r of data.resources)if(r.projectId===projectId)add('resources',r.id);
  for(const c of data.captures)if(c.projectId===projectId)add('captures',c.id);
  for(const f of data.followups)if(f.projectId===projectId)add('followups',f.id);
  for(const c of data.contacts)if(c.roles.some(r=>r.projectId===projectId))add('contacts',c.id);
 }
 // Linked records give the model the facts needed to discuss a named task,
 // person, follow-up, or calendar block without dragging in other projects.
 for(const t of data.tasks)if(chosen.tasks.has(t.id)){
  add('projects',t.projectId);add('contacts',t.contactId);
  for(const id of t.dependencies)add('tasks',id);
  for(const b of data.blocks)if(b.taskId===t.id)add('blocks',b.id);
  for(const f of data.followups)if(f.taskId===t.id)add('followups',f.id);
  for(const c of data.captures)if(c.taskId===t.id)add('captures',c.id);
 }
 for(const f of data.followups)if(chosen.followups.has(f.id)){add('projects',f.projectId);add('tasks',f.taskId);add('contacts',f.contactId)}
 for(const c of data.captures)if(chosen.captures.has(c.id)){add('projects',c.projectId);add('tasks',c.taskId);add('followups',c.followupId)}
 for(const r of data.resources)if(chosen.resources.has(r.id))add('projects',r.projectId);
 for(const b of data.blocks)if(chosen.blocks.has(b.id)){add('tasks',b.taskId);add('contacts',b.contactId)}
 for(const c of data.contacts)if(explicit.has(recordKey('contacts',c.id))){
  for(const t of data.tasks)if(t.contactId===c.id)add('tasks',t.id);
  for(const b of data.blocks)if(b.contactId===c.id)add('blocks',b.id);
  for(const f of data.followups)if(f.contactId===c.id)add('followups',f.id);
 }
 for(const b of data.blocks)if([...dates].some(date=>b.start<addDays(date,1)+'T00:00'&&b.end>date+'T00:00')){
  add('blocks',b.id);add('tasks',b.taskId);add('contacts',b.contactId);
 }
 for(const t of data.tasks)if(chosen.tasks.has(t.id)){add('projects',t.projectId);add('contacts',t.contactId)}

 const scoped=Object.fromEntries(keys.map(k=>[k,data[k].filter(v=>chosen[k].has(v.id))])) as Pick<Data,Collection>;
 const omitted=Object.fromEntries(keys.map(k=>[k,data[k].length-scoped[k].length]).filter(([,count])=>Number(count)>0)) as Partial<Record<Collection,number>>;
 const context:ContextWorkspace={workRevision:data.workRevision,...scoped,coverage:{mode:'scoped',omitted,note:'这里只列出与本轮明确名称或日期相关的已保存记录。省略的记录仍然存在，不能把空列表当成不存在，也不能声称这是全局完整清单；若本轮仅问某日的日程，该日所有时间相交的日程已列出。不确定时请用户指明对象。'}};
 if(JSON.stringify(context).length>budget)throw new ContextTooLargeError('相关记录本身超过本轮可安全核对的范围，请缩小到一个事项、联系人或更短的时间段。');
 const visible=new Set(keys.flatMap(k=>scoped[k].map(v=>recordKey(k,v.id))));
 return {context,visible,editable};
}

export function assertVisibleOperations(data:Data,operations:Operation[],visible:Set<string>|null,editable:Set<string>|null){
 if(!visible||!editable)return;
 for(const op of operations){
  const collection=collections[op.type.split('.')[0]],value=op.data as {id?:string;name?:string;projectId?:string;taskId?:string;followupId?:string;contactId?:string;dependencies?:string[];roles?:{projectId:string}[]}|undefined;
  if(!collection)continue;
  const id=op.id||value?.id||'',existing=data[collection].find(v=>v.id===id);
  if(existing&&!editable.has(recordKey(collection,id)))throw new ContextTooLargeError('这项修改涉及本轮没有明确点名的记录，请在原话中写明具体项目或事项名称后重试。');
  if(!op.type.endsWith('.save'))continue;
  for(const [kind,reference] of [['projects',value?.projectId],['tasks',value?.taskId],['followups',value?.followupId],['contacts',value?.contactId],...(value?.dependencies||[]).map(id=>['tasks',id] as const),...(value?.roles||[]).map(role=>['projects',role.projectId] as const)] as const){
   if(reference&&data[kind].some(v=>v.id===reference)&&!visible.has(recordKey(kind,reference)))throw new ContextTooLargeError('这项修改关联了本轮未完整提供的对象，请写明关联项目、事项或联系人。');
  }
  if(existing)continue;
  if(!value?.name||!['projects','tasks','contacts','resources'].includes(collection))continue;
  const duplicate=data[collection].find(v=>normalize(v.name)===normalize(value.name!)&&(
   collection==='projects'||collection==='contacts'||('projectId' in v&&v.projectId===value.projectId)
  ));
  if(duplicate)throw new ContextTooLargeError('工作空间里已有同名记录，请指明是更新现有记录还是另建不同名称。');
 }
}
