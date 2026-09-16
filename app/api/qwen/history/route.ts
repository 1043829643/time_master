import {z} from 'zod';
import {owner,binding,errorResponse} from '@/lib/store';
import {chatHistory} from '@/lib/chat-state';
export async function GET(req:Request){try{
 const user=await owner(req),raw=new URL(req.url).searchParams.get('cursor'),cursor=raw?z.object({at:z.string().min(1).max(50),id:z.string().min(1).max(100)}).parse(JSON.parse(raw)):undefined;
 return Response.json(await chatHistory(binding(),user,cursor),{headers:{'Cache-Control':'no-store'}});
}catch(e){return errorResponse(e)}}
