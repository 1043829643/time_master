import {z} from 'zod';
import {owner,guardOrigin,readJson,readWorkspace,writeWorkspace,errorResponse} from '@/lib/store';
import {baselineSchema} from '@/lib/changes';
export async function GET(req:Request){try{return Response.json(await readWorkspace(await owner(req)),{headers:{'Cache-Control':'no-store'}})}catch(e){return errorResponse(e)}}
export async function POST(req:Request){try{guardOrigin(req);const user=await owner(req),body=z.object({revision:z.number().int().min(0),workRevision:z.number().int().min(0).optional(),baseline:baselineSchema.optional(),reviewedRevision:z.number().int().min(0).optional(),operations:z.array(z.unknown()).min(1).max(60),operationId:z.string().min(8).max(100),summary:z.string().max(300).default('更新工作空间')}).parse(await readJson(req));return Response.json(await writeWorkspace(user,body.revision,body.operations,body.operationId,body.summary,body.workRevision,body.baseline,body.reviewedRevision));}catch(e){return errorResponse(e)}}
