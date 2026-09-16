import {z} from 'zod';
import {applyOperations,type Data} from './domain.ts';
import {proposalSchema} from './chat-state.ts';
import {describeChanges,changeWarnings} from './planning.ts';

export function parseAssistantResponse(message:any,data:Data,requestId:string){
 if(message?.tool_calls?.length!==1)throw new Error('回复没有形成完整结果');
 const tool=message.tool_calls[0].function,args=JSON.parse(tool.arguments);
 if(tool.name==='reply_to_user'){
  const {reply}=z.object({reply:z.string().trim().min(1).max(16000)}).parse(args);
  if(/请[^。\n]*(?:下方变更|下方方案|点击应用)|已为你(?:安排|创建|修改|删除)|已(?:保存|写入)成功/.test(reply))throw new Error('回复提到了安排，但没有附上方案');
  return {reply,draft:null};
 }
 if(tool.name!=='propose_changes')throw new Error('回复使用了未知操作');
 const draft=proposalSchema.parse(args);if(draft.operations.some(o=>o.type==='message.add'))throw new Error('方案不能修改聊天记录');
 applyOperations(data,draft.operations,'validate-'+requestId);
 draft.summary=describeChanges(data,draft.operations);
 const warnings=changeWarnings(data,draft.operations).map(w=>w.message);
 return {draft,reply:draft.summary+(warnings.length?'\n需要留意：'+warnings.slice(0,5).join('；'):'')+'\n方案已准备好，查看「待确认方案」后应用。'};
}
