import {env} from 'cloudflare:workers';
import {commitWorkspace,readChatReceipt,proposalSchema} from './chat-state';
import {mergeChanges,ChangeConflict,MergeValidationError,type ChangeBaseline} from './changes';
import {changeWarnings} from './planning';
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {applyOperations,emptyData,validateData,type Data,type Snapshot} from './domain';
import {loadWorkspace,readOperation,type OperationReceipt} from './workspace-storage';
import {fingerprint} from './fingerprint';
import {stable} from './changes';
import {readMemories,constraintViolations,memoriesForProposal} from './conversation-memory';
import {localDay} from './domain';
export class ApiError extends Error{constructor(message:string,public status=400,public details?:unknown){super(message)}}
export async function owner(req:Request){const u=await getChatGPTUser();if(u)return u.userId;const host=new URL(req.url).hostname;if(process.env.NODE_ENV!=='production'&&['127.0.0.1','localhost','[::1]'].includes(host))return 'local-owner';throw new ApiError('请先登录后使用工作空间。',401);}
export function guardOrigin(req:Request){const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)throw new ApiError('请求来源不匹配。',403);}
export async function readJson(req:Request,limit=1000000){const reader=req.body?.getReader();if(!reader)throw new ApiError('请求内容为空');const parts:Uint8Array[]=[];let size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new ApiError('内容过大，请减少内容后重试。',413)}parts.push(value)}const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length}try{return JSON.parse(new TextDecoder().decode(bytes))}catch{throw new ApiError('内容格式无效。')}}
export function binding(){if(!env.DB)throw new ApiError('数据服务暂不可用，请稍后重试。',503);return env.DB;}
export async function readWorkspace(user:string):Promise<Snapshot>{return loadWorkspace(binding(),user);}
export async function writeWorkspace(user:string,base:number,ops:unknown,operationId:string,summary:string,workRevision?:number,baseline?:ChangeBaseline,reviewedRevision?:number):Promise<Snapshot&{receipt?:OperationReceipt}>{
 const hash=fingerprint(stable(operationId.endsWith('-apply')?{proposalId:operationId}:{ops,baseline,summary}));
 for(let attempt=0;attempt<4;attempt++){
  const current=await readWorkspace(user),receipt=await readOperation(binding(),user,operationId);
  if(receipt){if(receipt.fingerprint&&receipt.fingerprint!==hash)throw new ApiError('这次提交的内容已改变，请重新保存。',409);if(receipt.status==='cancelled')throw new ApiError('上次提交已结束，请再次保存当前内容。',409,{code:'OPERATION_CLOSED'});return {...await readWorkspace(user),receipt};}
  if(current.data.appliedIds.includes(operationId))return current;
  let requested=ops,origin=baseline,description=summary,expected=workRevision;
  if(operationId.endsWith('-apply')){
   const receipt=await readChatReceipt(binding(),user,operationId.slice(0,-6));
   if(!receipt?.proposal)throw new ApiError('方案不存在，请重新读取。',409);
   if(receipt.proposal_state==='applied')return current;
   if(receipt.proposal_state!=='pending')throw new ApiError(receipt.state_reason||'这份方案已经撤回或被新决定替代，请查看最新安排。',409,{code:'PLAN_CLOSED',snapshot:current});
   if(receipt.protocol_version===0)throw new ApiError('这份早期方案需要按当前安排重新整理。',409,{code:'PLAN_CLOSED',snapshot:current});
   const proposal=proposalSchema.parse(JSON.parse(receipt.proposal));requested=proposal.operations;description=proposal.summary;origin=receipt.base_records?JSON.parse(receipt.base_records):undefined;expected=receipt.work_revision;
  }
  if(!origin&&(expected===undefined?current.revision!==base:current.data.workRevision!==expected))throw new ApiError('项目或日程已有其他修改。你的输入仍保留，请同步最新数据后核对。',409,{code:'STALE',snapshot:current});
  let merged;
  try{merged=origin?mergeChanges(current.data,requested,origin):requested as import('./domain').Operation[];}catch(e){if(e instanceof ChangeConflict)throw new ApiError(e.message,409,{code:'FIELD_CONFLICT',conflicts:e.conflicts,snapshot:current});if(e instanceof MergeValidationError)throw new ApiError(e.message,409,{code:'INVALID_MERGE',message:e.message,operations:e.operations,snapshot:current,conflicts:[]});throw e;}
  const warnings=changeWarnings(current.data,merged);
  if(operationId.endsWith('-apply')||operationId.endsWith('-undo')){const known=await readMemories(binding(),user,localDay()),memories=operationId.endsWith('-apply')?await memoriesForProposal(binding(),user,known,operationId.slice(0,-6)):known;const violations=constraintViolations(current.data,merged,memories);if(violations.length)throw new ApiError('方案与已确认的限制不符，请调整后再应用。',409,{code:'CONSTRAINT_CONFLICT',warnings:violations,snapshot:current});}
  if(warnings.length&&reviewedRevision!==current.data.workRevision)throw new ApiError('请核对这次修改对现有安排的影响。',409,{code:'REVIEW_REQUIRED',warnings,snapshot:current});
  const data=merged.length?applyOperations(current.data,merged,operationId,description):{...current.data,appliedIds:[...current.data.appliedIds,operationId].slice(-100)};
  if(await commitWorkspace(binding(),user,current,data,operationId,hash))return {data,revision:current.revision+1,receipt:(await readOperation(binding(),user,operationId))!};
 }
 throw new ApiError('其他页面正在保存，请稍后重试；本次输入仍保留。',409);
}
export function errorResponse(error:unknown){if(error instanceof ApiError)return Response.json({error:error.message,details:error.details},{status:error.status});if(error instanceof Error&&error.name==='ZodError')return Response.json({error:'输入字段不完整或格式无效，请检查日期、名称和编号。'},{status:400});return Response.json({error:error instanceof Error?error.message.replace(/sk-[\w.=-]+/g,'[已隐藏]'):'操作失败，请重试。'},{status:400});}
