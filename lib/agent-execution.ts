import {mergeChanges,captureBaseline} from './changes.ts';
import {changeWarnings,describeChanges} from './planning.ts';
import {constraintViolations,type ConversationMemory} from './conversation-memory.ts';
import {type Data} from './domain.ts';
import {type Proposal} from './chat-state.ts';
import {type ReviewablePlan} from './proposal-review.ts';

export function resolveExecution(data:Data,draft:Proposal|null,decision:{mode:string;quote:string;proposalId?:string},text:string,pending:ReviewablePlan[],memories:ConversationMemory[]){
 let operations=draft?.operations,sourceProposalId:string|undefined;
 if(decision.mode==='confirm'){
  if(!decision.quote||!text.includes(decision.quote)||!/(?:确认|应用|执行|就这样|按这个|照这个|好的|可以|同意)/.test(decision.quote))throw new Error('请明确要应用的方案。');
  const selected=decision.proposalId?pending.find(p=>p.id.replace(/-apply$/,'')===decision.proposalId!.replace(/-apply$/,'')):pending.length===1?pending[0]:undefined;
  if(!selected)throw new Error('有多个或没有待确认方案，请说明要应用哪一份。');
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
