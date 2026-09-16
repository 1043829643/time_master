import {z} from 'zod';
import {owner,guardOrigin,readJson,readWorkspace,binding,errorResponse,ApiError} from '@/lib/store';
import {pendingProposals} from '@/lib/chat-state';

export async function GET(req:Request){try{
 const user=await owner(req),snapshot=await readWorkspace(user),url=new URL(req.url),raw=url.searchParams.get('cursor');
 const cursor=raw?z.object({at:z.string().max(50),id:z.string().max(100)}).parse(JSON.parse(raw)):undefined;
 return Response.json({snapshot,...await pendingProposals(binding(),user,snapshot,cursor)},{headers:{'Cache-Control':'no-store'}});
}catch(e){return errorResponse(e)}}
export async function POST(req:Request){try{
 guardOrigin(req);const user=await owner(req),{id}=z.object({id:z.string().min(1).max(100)}).parse(await readJson(req));
 if(!id.endsWith('-apply'))throw new ApiError('方案编号无效。');
 await binding().prepare("UPDATE chat_receipts SET proposal_state = 'dismissed' WHERE owner = ? AND request_id = ? AND proposal_state = 'pending'").bind(user,id.slice(0,-6)).run();
 return Response.json({ok:true});
}catch(e){return errorResponse(e)}}
