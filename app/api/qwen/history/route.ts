import {z} from 'zod';
import {owner,binding,errorResponse} from '@/lib/store';
import {chatHistory,chatUpdates} from '@/lib/chat-state';
export async function GET(req:Request){try{
 const user=await owner(req),params=new URL(req.url).searchParams;
 if(params.has('after')){const after=z.coerce.number().int().nonnegative().parse(params.get('after')),until=params.has('until')?z.coerce.number().int().min(after).parse(params.get('until')):undefined;return Response.json(await chatUpdates(binding(),user,after,until),{headers:{'Cache-Control':'no-store'}});}
 const raw=params.get('cursor'),cursor=raw?z.object({at:z.string().min(1).max(50),id:z.string().min(1).max(100)}).parse(JSON.parse(raw)):undefined;
 return Response.json(await chatHistory(binding(),user,cursor),{headers:{'Cache-Control':'no-store'}});
}catch(e){return errorResponse(e)}}
