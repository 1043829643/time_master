import {owner,guardOrigin,readJson,errorResponse,readWorkspace,binding,ApiError} from '@/lib/store';
import {localDay} from '@/lib/domain';
import {readMemories,memoryStatements} from '@/lib/conversation-memory';
import {commitHeader} from '@/lib/workspace-storage';
import {z} from 'zod';
export async function GET(req:Request){try{const user=await owner(req);return Response.json({memories:await readMemories(binding(),user,localDay())},{headers:{'Cache-Control':'no-store'}})}catch(e){return errorResponse(e)}}
export async function POST(req:Request){try{
 guardOrigin(req);const user=await owner(req),{id}=z.object({id:z.string().min(1).max(100)}).parse(await readJson(req)),db=binding();
 for(let i=0;i<3;i++){
  const current=await readWorkspace(user),token=crypto.randomUUID();
  const result=await db.batch([commitHeader(db,user,current,current.data,token),...memoryStatements(db,user,token,[],[id])]);
  if(result[0].meta.changes===1)return Response.json({snapshot:await readWorkspace(user),memories:await readMemories(db,user,localDay())});
 }
 throw new ApiError('记忆刚刚更新，请重试。',409);
}catch(e){return errorResponse(e)}}
