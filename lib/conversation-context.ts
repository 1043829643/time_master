import {addDays,type Data,type Operation} from './domain.ts';
import {requiredRelativeDates} from './conversation-dates.ts';

export const CHAT_CONTEXT_LIMIT=96000;
export const CHAT_REVIEW_RESERVE=24000;
export const CHAT_REVIEW_CANDIDATE_LIMIT=16000;
const keys=['projects','tasks','blocks','contacts','resources','captures','followups'] as const;
type Collection=typeof keys[number];
type Workspace=Pick<Data,Collection|'workRevision'>;
type ContextWorkspace=Workspace&{coverage:{mode:'complete'|'scoped';omitted?:Partial<Record<Collection,number>>;note?:string}};
export type ContextHints={messages?:Data['messages'];pending?:{id:string;operations:Operation[]}[]};
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
const readOnly=(text:string)=>{
 const hardStops=[...text.matchAll(/(?:先别|暂时别|先不|不要|不用).{0,5}(?:改|存|执行|安排|应用|提交)|别(?:动|改|应用|提交|保存)|不修改|不改动/g)];
 const looking=/(?:只|先).{0,3}(?:看|查|建议|讨论|聊)/.test(text);
 // A requested draft is a reviewable result, even when the user explicitly
 // forbids applying it. Execution authorization is checked separately.
 const asksForProposal=/(?:看|出|提|生成|做|给).{0,8}方案|方案.{0,8}(?:看|出|给)/.test(text);
 const laterAction=/(?:另外|再|然后|接着|顺便)(?:帮我|请|给我)?(?:安排|创建|新建|新增|添加|改|挪|记|保存|排)/;
 const lastStop=hardStops.at(-1),actionAfterStop=lastStop&&laterAction.test(text.slice((lastStop.index||0)+lastStop[0].length));
 const pureDiscussion=!!lastStop&&!actionAfterStop||looking&&!laterAction.test(text)||contextFreeChat(text);
 return pureDiscussion&&!asksForProposal||socialOnly(text);
};
const refersBack=(text:string)=>/那个|这个|它|刚才|上面|之前|前面|原来|同一个|那份|这份|就这样|照这个|按刚才|继续|再改|改成|挪到|移到|提前|推迟|确认|应用|^那(?:周|天|个|份|这)/.test(text);
const changesExisting=(text:string)=>/改|挪|移|提前|推迟|延后|更新|补充|追加|标记|完成|取消|删除|归档|排到|安排到|定在|放到/.test(text);
const confirmsPending=(text:string)=>/就这样|就按|照刚才|按刚才|按那个方案|那份方案|这份方案|那个方案|这个方案|应用(?:这个|那份|刚才|方案)|^(?:好|可以)?(?:确认|应用)[。！!？?]?$/.test(text.trim());
const asksDailyWork=(text:string)=>/(?:今天|明天|后天|周[一二三四五六日天]|\d{1,2}月\d{1,2}日|\d{4}-\d{2}-\d{2}).{0,16}(?:做什么|先做|该做|干什么|待办|任务|事项|优先|推进什么|安排工作|工作怎么安排|可做什么)/.test(text);
const generalChat=(text:string)=>/聊聊|聊天|说说话|有点累|很累|焦虑|烦|难过|开心|没想好|理理思路|给我建议|先不安排|先别做|只是想想/.test(text);
const contextFreeChat=(text:string)=>generalChat(text)&&!/(?:项目|事项|任务|日程|会议|跟进|文件|工程|微信|联系人|工作空间|全部|所有|进度|截止|新增|新建|创建|添加|记下|帮我记|先记|记着|记录|保存|安排|改|挪|删除|取消)/.test(text);

export function relevantUnfinished<T extends {request_id:string;request_text:string;state:string}>(requests:T[],currentId:string,text:string,budget=10000){
 // A failed message belongs to the current turn only when the user explicitly
 // continues the immediately preceding request. Older failures are not context.
 if(!/(?:刚才|刚刚|上一条|前一条|那条|前面说的|重试|再试|补充一下|我补充|那个没成功|继续(?:处理|做|刚才|那个))/.test(text)&&text.trim()!=='继续')return {included:[] as T[],omittedCount:0};
 const previous=requests.filter(r=>r.request_id!==currentId).at(-1);
 return previous?.state==='failed'?recentUnfinished([previous],currentId,budget):{included:[] as T[],omittedCount:0};
}

function requestedDates(text:string,today:string){
 const dates=new Set([...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(m=>m[0]));
 for(const date of dates){const parsed=new Date(date+'T12:00:00Z');if(isNaN(+parsed)||parsed.toISOString().slice(0,10)!==date)throw new ContextTooLargeError('日期似乎无效，请写明正确的年月日。')}
 for(const relative of requiredRelativeDates(text,today))dates.add(relative);
 // Alternatives are not required output dates, but the assistant must see
 // both calendars before it can compare them for the user.
 if(/或者|或是|还是|或/.test(text))for(const mention of text.match(/(?:下下周|下周|本周|这周)[一二三四五六日天]|后天|明天|今天/g)||[]){
  for(const relative of requiredRelativeDates(mention,today))dates.add(relative);
 }
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

export function assertPendingConfirmationCoverage(mode:string,omittedCount:number,text=''){
 if(omittedCount>0&&(mode==='confirm'||confirmsPending(text)))throw new ContextTooLargeError('待确认方案过多，请先在方案列表中选定并应用，或指出具体方案。');
}

export function assertReadOnlyTurn(onlyRead:boolean,operations:Operation[],transitions:unknown[],mode:string){
 if(onlyRead&&(operations.length||transitions.length||mode==='confirm'))throw new Error('用户这轮只想了解或讨论，不能修改或确认安排。');
}

export function conversationWorkspace(data:Data,text:string,budget:number,today:string,hints:ContextHints={}){
 const full=basic(data),fullContext:ContextWorkspace={...full,coverage:{mode:'complete'}};
 if(JSON.stringify(fullContext).length<=budget)return {context:fullContext,visible:null as Set<string>|null,editable:null as Set<string>|null,readOnly:readOnly(text)};
 if(budget<3000)throw new ContextTooLargeError('当前待确认内容和对话记录过多，请先处理待确认方案，或缩短本轮输入。');

 const chosen:Record<Collection,Set<string>>=Object.fromEntries(keys.map(k=>[k,new Set<string>()])) as Record<Collection,Set<string>>;
 const add=(collection:Collection,id:string|undefined)=>{if(!id||chosen[collection].has(id))return false;chosen[collection].add(id);return true};
 const explicit=new Set<string>(),normalizedText=normalize(text);
 for(const collection of keys)for(const value of data[collection])if(named(normalizedText,value)){
  add(collection,value.id);explicit.add(recordKey(collection,value.id));
 }
 const dates=requestedDates(text,today);
 const dailyWork=dates.size>0&&asksDailyWork(text),dateScheduleRead=dates.size>0&&((/(日程|会议|安排|行程)/.test(text)&&/(哪些|有什么|看|查|列|几|几点)/.test(text))||/(?:有空|空不空|空闲|哪天.{0,4}空)/.test(text))&&!/(能做|可做|优先|待办|事项|任务)/.test(text);
 let inferredKey='';
 // Continuation may use the nearest user's exact naming, never an assistant
 // paraphrase or an old, already-closed proposal. A turn with two candidates
 // is deliberately not resolved by recency or array order.
 if(!explicit.size&&refersBack(text)){
  const previous=[...(hints.messages||[])].reverse().find(m=>m.role==='user');
  if(previous){const prior=normalize(previous.content),matches=keys.flatMap(k=>data[k].filter(v=>named(prior,v)).map(v=>recordKey(k,v.id)));
   if(matches.length===1){const separator=matches[0].indexOf(':'),kind=matches[0].slice(0,separator) as Collection,id=matches[0].slice(separator+1);
    const value=data[kind].find(v=>v.id===id);
    const suffix=normalize(value?.name||'');
    // If this turn names another object even partially, do not carry the old one.
    const conflicting=keys.some(k=>data[k].some(v=>v.id!==id&&[v.name,(v as {shortName?:string}).shortName].some(name=>{const n=normalize(name||'');return n.length>=3&&normalizedText.includes(n)})));
    if(!conflicting&&(suffix.length<2||normalizedText.includes(suffix.slice(-2))||/(那个|这个|它|刚才|上面|之前|前面|原来|同一个|那份|这份|就这样|照这个|按刚才|继续|^那(?:周|天|个|份|这))/.test(text))){add(kind,id);inferredKey=matches[0]}
   }
  }
 }
 const singlePending=confirmsPending(text)&&hints.pending?.length===1;
 if(singlePending){
  for(const op of hints.pending![0].operations){const kind=collections[op.type.split('.')[0]],id=op.type.endsWith('.save')?(op.data as {id?:string})?.id:op.id;
   if(kind&&id&&data[kind].some(v=>v.id===id))add(kind,id);
  }
 }
 if(dailyWork)for(const date of dates){
  for(const task of data.tasks)if(task.status!=='done'&&task.start<=date)add('tasks',task.id);
  for(const followup of data.followups)if(followup.status==='waiting'&&(!followup.dueAt||followup.dueAt.slice(0,10)<=date))add('followups',followup.id);
  for(const capture of data.captures)if(capture.status==='inbox'&&(!capture.reviewOn||capture.reviewOn<=date))add('captures',capture.id);
 }
 const onlyHolds=/(?:别应用|先放着|别动|别改|不要改)/.test(text)&&!/(?:有什么|进度|哪|怎么|为什么|谁|几点|有空|查询|看看|安排|新建|添加|记录|保存|帮我)/.test(text);
 if(!explicit.size&&!inferredKey&&!singlePending&&!likelyNew(text)&&!socialOnly(text)&&!contextFreeChat(text)&&!onlyHolds&&!dateScheduleRead&&!dailyWork&&!chosenProjects())throw new ContextTooLargeError('工作空间较大，请说出具体项目或事项；如果是接着上一句，请说“刚才那个事项”并补充要看什么。');

 function chosenProjects(){return keys.some(k=>chosen[k].size>0)}

 // A named project means its entire current project area, including parallel work.
 const explicitProjects=new Set(data.projects.filter(p=>explicit.has(recordKey('projects',p.id))).map(p=>p.id));
 const editable=new Set(readOnly(text)?[]:explicit);
 if(inferredKey&&!readOnly(text)&&changesExisting(text))editable.add(inferredKey);
 for(const projectId of explicitProjects){
  for(const t of data.tasks)if(t.projectId===projectId){add('tasks',t.id);if(!readOnly(text)&&/(?:所有|全部|每个|项目下).{0,8}(?:事项|任务)/.test(text))editable.add(recordKey('tasks',t.id))}
  for(const r of data.resources)if(r.projectId===projectId)add('resources',r.id);
  for(const c of data.captures)if(c.projectId===projectId)add('captures',c.id);
  for(const f of data.followups)if(f.projectId===projectId)add('followups',f.id);
  for(const c of data.contacts)if(c.roles.some(r=>r.projectId===projectId))add('contacts',c.id);
 }
 for(const c of data.contacts)if(explicit.has(recordKey('contacts',c.id))){
  for(const t of data.tasks)if(t.contactId===c.id)add('tasks',t.id);
  for(const b of data.blocks)if(b.contactId===c.id)add('blocks',b.id);
  for(const f of data.followups)if(f.contactId===c.id)add('followups',f.id);
 }
 for(const b of data.blocks)if([...dates].some(date=>b.start<addDays(date,1)+'T00:00'&&b.end>date+'T00:00')){
  add('blocks',b.id);add('tasks',b.taskId);add('contacts',b.contactId);
 }
 // Close links after selecting date blocks as well as named work. In particular,
 // a task reached through a meeting may itself have blocking follow-ups.
 let changed=true;while(changed){changed=false;
  for(const t of data.tasks)if(chosen.tasks.has(t.id)){
   changed=add('projects',t.projectId)||changed;changed=add('contacts',t.contactId)||changed;
   for(const id of t.dependencies)changed=add('tasks',id)||changed;
   for(const b of data.blocks)if(b.taskId===t.id&&(!(dailyWork||dateScheduleRead)||[...dates].some(date=>b.start<addDays(date,1)+'T00:00'&&b.end>date+'T00:00')))changed=add('blocks',b.id)||changed;
   for(const f of data.followups)if(f.taskId===t.id&&(!dailyWork||f.status==='waiting'))changed=add('followups',f.id)||changed;
   for(const c of data.captures)if(c.taskId===t.id&&(!dailyWork||c.status==='inbox'&&(!c.reviewOn||[...dates].some(date=>c.reviewOn<=date))))changed=add('captures',c.id)||changed;
  }
  for(const f of data.followups)if(chosen.followups.has(f.id)){changed=add('projects',f.projectId)||changed;changed=add('tasks',f.taskId)||changed;changed=add('contacts',f.contactId)||changed}
  for(const c of data.captures)if(chosen.captures.has(c.id)){changed=add('projects',c.projectId)||changed;changed=add('tasks',c.taskId)||changed;changed=add('followups',c.followupId)||changed}
  for(const r of data.resources)if(chosen.resources.has(r.id))changed=add('projects',r.projectId)||changed;
  for(const b of data.blocks)if(chosen.blocks.has(b.id)){changed=add('tasks',b.taskId)||changed;changed=add('contacts',b.contactId)||changed}
 }

 const scoped=Object.fromEntries(keys.map(k=>[k,data[k].filter(v=>chosen[k].has(v.id))])) as Pick<Data,Collection>;
 const omitted=Object.fromEntries(keys.map(k=>[k,data[k].length-scoped[k].length]).filter(([,count])=>Number(count)>0)) as Partial<Record<Collection,number>>;
 const note=dailyWork?'这里只列出指定日期可推进的事项、待处理跟进与随手记，以及当天全部交叠日程；已完成和未来才开始的事项不在今日候选中。省略记录仍存在，不能声称这是全局清单。':
  '这里只列出与本轮明确名称、日期、最近用户续话或仍待确认方案相关的已保存记录。省略记录仍存在，不能把空列表当成不存在，也不能声称这是全局完整清单；若本轮仅问某日的日程，该日所有时间相交的日程已列出。历史续话仅供理解，不能凭它猜测修改对象。';
 const context:ContextWorkspace={workRevision:data.workRevision,...scoped,coverage:{mode:'scoped',omitted,note}};
 if(JSON.stringify(context).length>budget)throw new ContextTooLargeError(dailyWork?'今天可考虑的事项较多，请指定一个项目或一段可用时间，再一起排。':'相关记录本身超过本轮可安全核对的范围，请缩小到一个事项、联系人或更短的时间段。');
 const visible=new Set(keys.flatMap(k=>scoped[k].map(v=>recordKey(k,v.id))));
 return {context,visible,editable,readOnly:readOnly(text)};
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
