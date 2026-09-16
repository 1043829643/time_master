import {z} from 'zod';
import {owner,guardOrigin,readJson,readWorkspace,errorResponse,binding,ApiError} from '@/lib/store';
import {dayPlanSchema,makeDayPlan} from '@/lib/daily-planning';
import {readMemories} from '@/lib/conversation-memory';
import {localDay,applyOperations} from '@/lib/domain';
import {stable} from '@/lib/changes';
import {fingerprint} from '@/lib/fingerprint';
import {commitWorkspace} from '@/lib/chat-state';
import {changeWarnings} from '@/lib/planning';
import {readOperation} from '@/lib/workspace-storage';
export async function POST(req:Request){try{
 guardOrigin(req);const user=await owner(req),body=z.object({input:dayPlanSchema,requestId:z.string().uuid(),preview:z.boolean(),reviewedRevision:z.number().optional(),planHash:z.string().optional()}).parse(await readJson(req));
 const current=await readWorkspace(user),id='daily-'+body.requestId;
 const hash=fingerprint(stable(body.input)),receipt=await readOperation(binding(),user,id);
 if(!body.preview&&receipt){if(receipt.fingerprint!==hash)throw new ApiError('这次安排内容已改变，请重新预览。',409);return Response.json({snapshot:current,applied:true});}
 const memories=await readMemories(binding(),user,localDay()),plan=makeDayPlan(current.data,body.input,memories,body.requestId);
 const planHash=fingerprint(stable(plan.operations));
 if(body.preview)return Response.json({...plan,planHash,revision:current.revision,warnings:changeWarnings(current.data,plan.operations).map(w=>w.message)});
 if(body.reviewedRevision!==current.revision)throw new ApiError('安排或偏好刚刚有变化，请重新预览，避免按旧情况排程。',409);
 if(!plan.operations.length)throw new ApiError('没有可保存的安排。');
 if(body.planHash!==planHash)throw new ApiError('可用时段已变化，请重新预览后再保存。',409);
 if(!await commitWorkspace(binding(),user,current,applyOperations(current.data,plan.operations,id,'按可用时间安排 '+plan.plannedMinutes+' 分钟'),id,hash))throw new ApiError('安排刚刚更新，请重新预览。',409);
 return Response.json({snapshot:await readWorkspace(user),applied:true});
}catch(e){return errorResponse(e)}}
