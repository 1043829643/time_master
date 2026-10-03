import {mergeChanges,captureBaseline,records,type Kind} from './changes.ts';
import {changeWarnings,describeChanges} from './planning.ts';
import {constraintViolations,type ConversationMemory} from './conversation-memory.ts';
import {type Data} from './domain.ts';
import {type Proposal} from './chat-state.ts';
import {type ReviewablePlan} from './proposal-review.ts';

// The model may quote only the assent in a mixed utterance. Inspect the whole
// user turn before treating an existing proposal as unconditionally approved.
export function hasConfirmationReservation(text:string){
 // "No need to change it; apply the original" is an assent, while any other
 // hold or edit in the same turn still wins over that assent.
 const words=text.replace(/\s+/g,'').replace(/(?:不用|不要|不必|不)(?:再)?(?:改|修改|调整)(?:了)?/g,'');
 return /(?:先别|暂时别|别急|先不|暂不|还不|不要|不用|不做|不存|不改|不能|不准|等一下|等等|先等等|先缓缓)|别(?:给我)?(?:动|碰|应用|执行|保存|存|确认|提交|安排|做)|(?:先|再)(?:看看|想想|考虑|讨论)|(?:明天|晚点|稍后|回头|以后|下次)(?:再|才)?(?:说|看|确认|应用|执行|保存|存)|(?:除(?:了|去)|只(?:确认|应用|执行|保存)|仅(?:确认|应用|执行|保存))|(?:取消|去掉|删掉|拿掉|改成|改到|换成|挪到|调整|补一句|补充)|(?:但是|不过|但|只是|另外|其中|第一|第二|第三).{0,24}(?:取消|去掉|删|改|换|先放|放一下|新增|添加)/.test(words);
}

function explicitlySelectsPlan(data:Data,text:string,pending:ReviewablePlan[],selected:ReviewablePlan){
 if(pending.length===1)return true;
 const ordinals=[...text.matchAll(/第([一二三四五六七八九十]|[1-9]\d?)(?:个|份|条)(?:方案|安排)?(?!事项|任务|日程|项目|会议)/g)];
 if(ordinals.length){
  const number=(s:string)=>/^\d+$/.test(s)?Number(s):'一二三四五六七八九十'.indexOf(s)+1;
  return ordinals.length===1&&pending[number(ordinals[0][1])-1]?.id===selected.id;
 }
 const normalized=text.replace(/\s+/g,'').toLocaleLowerCase('zh-CN');
 const scores=pending.map(plan=>Math.max(0,...plan.operations.flatMap(op=>{
  const kind=op.type.split('.')[0] as Kind,id=op.id||String((op.data as {id?:string}|undefined)?.id||'');
  const name=String((op.data as {name?:string}|undefined)?.name||records(data,kind).find(v=>v.id===id)?.name||'');
  const label=name.replace(/\s+/g,'').toLocaleLowerCase('zh-CN');
  return label.length>=2&&normalized.includes(label)?[label.length]:[];
 })));
 const selectedIndex=pending.findIndex(plan=>plan.id===selected.id);
 return selectedIndex>=0&&scores[selectedIndex]>0&&scores.every((score,index)=>index===selectedIndex||score<scores[selectedIndex]);
}

export function resolveExecution(data:Data,draft:Proposal|null,decision:{mode:string;quote:string;proposalId?:string},text:string,pending:ReviewablePlan[],memories:ConversationMemory[]){
 let operations=draft?.operations,sourceProposalId:string|undefined;
 if(decision.mode==='confirm'){
  if(!decision.quote||!text.includes(decision.quote)||!/(?:确认|应用|执行|就这样|按这个|照这个|好的|可以|同意)/.test(decision.quote))throw new Error('请明确要应用的方案。');
  if(hasConfirmationReservation(text))return {execution:undefined,draft:null,notice:'原方案已保留在待确认；需要修改其中一部分时，请说明具体哪项。'};
  const selected=decision.proposalId?pending.find(p=>p.id.replace(/-apply$/,'')===decision.proposalId!.replace(/-apply$/,'')):pending.length===1?pending[0]:undefined;
  if(!selected)throw new Error('有多个或没有待确认方案，请说明要应用哪一份。');
  if(!explicitlySelectsPlan(data,text,pending,selected))return {execution:undefined,draft:null,notice:'这里有多份待确认方案，请说出要应用的事项名称或第几份方案；原方案都已保留。'};
  if(!selected.baseline||selected.protocolVersion===0)throw new Error('这份旧方案需要按当前情况重新整理。');
  operations=mergeChanges(data,selected.operations,selected.baseline);sourceProposalId=selected.id.replace(/-apply$/,'');
 }
 if(!operations?.length||!['execute','confirm'].includes(decision.mode))return {execution:undefined,draft,notice:''};
 if(!decision.quote||!text.includes(decision.quote))throw new Error('执行需要来自本轮的明确指令。');
 const violations=constraintViolations(data,operations,memories);if(violations.length)throw new Error(violations.join('；'));
 const warnings=changeWarnings(data,operations);
 // A natural-language confirmation applies the original reviewed plan, but a
 // changed world must be reviewed again, including newly introduced conflicts.
 if(warnings.length){return {execution:undefined,draft:sourceProposalId?null:{summary:describeChanges(data,operations),operations},notice:'执行前需要核对：'+warnings.map(w=>w.message).join('；')+'。请在方案中核对后应用。'};}
 return {execution:{operations,sourceProposalId},draft:null,notice:'',summary:describeChanges(data,operations,6000),baseline:captureBaseline(data,operations)};
}
