import {z} from 'zod';
import {owner,guardOrigin,readJson,readWorkspace,binding,errorResponse,ApiError} from '@/lib/store';
import {pendingProposals,dismissProposal,readChatReceipt} from '@/lib/chat-state';

export async function GET(req:Request){try{
 const user=await owner(req),snapshot=await readWorkspace(user),url=new URL(req.url),raw=url.searchParams.get('cursor');
 const cursor=raw?z.object({at:z.string().max(50),id:z.string().max(100)}).parse(JSON.parse(raw)):undefined;
 return Response.json({snapshot,...await pendingProposals(binding(),user,snapshot,cursor)},{headers:{'Cache-Control':'no-store'}});
}catch(e){return errorResponse(e)}}
export async function POST(req:Request){try{
 guardOrigin(req);const user=await owner(req),{id}=z.object({id:z.string().min(1).max(100)}).parse(await readJson(req));
 if(!id.endsWith('-apply'))throw new ApiError('方案编号无效。');
 const db=binding();for(let retry=0;retry<4;retry++){
  const snapshot=await readWorkspace(user),receipt=await readChatReceipt(db,user,id.slice(0,-6));
  if(!receipt?.proposal)throw new ApiError('方案不存在，请重新读取。',404);
  if(receipt.proposal_state==='applied')throw new ApiError('这个方案已在其他页面应用，请查看最新安排。',409,{snapshot});
  if(receipt.proposal_state!=='pending')return Response.json({ok:true,snapshot});
  if(await dismissProposal(db,user,snapshot,id.slice(0,-6)))return Response.json({ok:true,snapshot:{...snapshot,revision:snapshot.revision+1}});
 }
 throw new ApiError('其他页面正在更新，请重试。',409);
}catch(e){return errorResponse(e)}}
