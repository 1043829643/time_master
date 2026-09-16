import {z} from 'zod';
import {owner,guardOrigin,readJson,readWorkspace,binding,errorResponse} from '@/lib/store';
import {baselineSchema,stable} from '@/lib/changes';
import {fingerprint} from '@/lib/fingerprint';
import {settleOperation,readOperation} from '@/lib/workspace-storage';
export async function GET(req:Request){try{const user=await owner(req),id=z.string().min(8).max(100).parse(new URL(req.url).searchParams.get('operationId'));return Response.json({receipt:await readOperation(binding(),user,id),snapshot:await readWorkspace(user)},{headers:{'Cache-Control':'no-store'}})}catch(e){return errorResponse(e)}}
export async function POST(req:Request){try{
 guardOrigin(req);const user=await owner(req),body=z.object({operationId:z.string().min(8).max(100),ops:z.array(z.unknown()).min(1).max(60),baseline:baselineSchema,summary:z.string().max(300)}).parse(await readJson(req,16000000));
 await readWorkspace(user);
 const receipt=await settleOperation(binding(),user,body.operationId,fingerprint(stable({ops:body.ops,baseline:body.baseline,summary:body.summary})));
 return Response.json({receipt,snapshot:await readWorkspace(user)});
}catch(e){return errorResponse(e)}}
