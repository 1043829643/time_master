import {env} from 'cloudflare:workers';
import {commitWorkspace,readChatReceipt} from './chat-state';
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {applyOperations,emptyData,validateData,type Data,type Snapshot} from './domain';
export class ApiError extends Error{constructor(message:string,public status=400){super(message)}}
export async function owner(req:Request){const u=await getChatGPTUser();if(u)return u.userId;const host=new URL(req.url).hostname;if(process.env.NODE_ENV!=='production'&&['127.0.0.1','localhost','[::1]'].includes(host))return 'local-owner';throw new ApiError('请先登录后使用工作空间。',401);}
export function guardOrigin(req:Request){const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)throw new ApiError('请求来源不匹配。',403);}
export async function readJson(req:Request,limit=1000000){const reader=req.body?.getReader();if(!reader)throw new ApiError('请求内容为空');const parts:Uint8Array[]=[];let size=0;for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new ApiError('内容过大，请减少内容后重试。',413)}parts.push(value)}const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length}try{return JSON.parse(new TextDecoder().decode(bytes))}catch{throw new ApiError('内容格式无效。')}}
export function binding(){if(!env.DB)throw new ApiError('数据服务暂不可用，请稍后重试。',503);return env.DB;}
export async function readWorkspace(user:string):Promise<Snapshot>{const db=binding();await db.prepare('INSERT OR IGNORE INTO workspaces (owner,payload,revision,updated_at) VALUES (?, ?, 0, ?)').bind(user,JSON.stringify(emptyData()),new Date().toISOString()).run();const row=await db.prepare('SELECT payload,revision FROM workspaces WHERE owner = ?').bind(user).first<{payload:string;revision:number}>();if(!row)throw new ApiError('工作空间读取失败。',503);return {data:validateData(JSON.parse(row.payload)),revision:row.revision};}
export async function writeWorkspace(user:string,base:number,ops:unknown,operationId:string,summary:string,workRevision?:number):Promise<Snapshot>{
 for(let attempt=0;attempt<4;attempt++){
  const current=await readWorkspace(user);if(current.data.appliedIds.includes(operationId))return current;
  if(operationId.endsWith('-apply')){const receipt=await readChatReceipt(binding(),user,operationId.slice(0,-6));if(receipt?.proposal_state==='applied')return await readWorkspace(user);if(receipt?.proposal_state==='dismissed')throw new ApiError('这个方案已放弃，请重新安排。',409);}
  // Conversation-only updates must not invalidate an open project editor or a proposal.
  if(workRevision===undefined?current.revision!==base:current.data.workRevision!==workRevision)throw new ApiError('项目或日程已有其他修改。你的输入仍保留，请同步最新数据后核对。',409);
  const data=applyOperations(current.data,ops,operationId,summary);
  if(await commitWorkspace(binding(),user,current,data,operationId))return {data,revision:current.revision+1};
 }
 throw new ApiError('其他页面正在保存，请稍后重试；本次输入仍保留。',409);
}
export function errorResponse(error:unknown){if(error instanceof ApiError)return Response.json({error:error.message},{status:error.status});if(error instanceof Error&&error.name==='ZodError')return Response.json({error:'输入字段不完整或格式无效，请检查日期、名称和编号。'},{status:400});return Response.json({error:error instanceof Error?error.message.replace(/sk-[\w.=-]+/g,'[已隐藏]'):'操作失败，请重试。'},{status:400});}
