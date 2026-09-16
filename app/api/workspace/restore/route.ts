import {z} from 'zod';
import {owner,guardOrigin,readJson,errorResponse,readWorkspace,binding,ApiError} from '@/lib/store';
import {businessSchema,restorePlan} from '@/lib/backup';
import {readRestore,commitRestore} from '@/lib/restore-state';
export async function POST(req:Request){try{
 guardOrigin(req);const user=await owner(req),body=z.object({data:businessSchema,mode:z.enum(['missing','copies']),requestId:z.string().uuid(),preview:z.boolean().default(false),reviewedRevision:z.number().int().min(0).optional()}).parse(await readJson(req,8000000));
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({data:body.data,mode:body.mode}))),fingerprint=Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join(''),db=binding();
 for(let attempt=0;attempt<4;attempt++){
  const receipt=await readRestore(db,user,body.requestId),current=await readWorkspace(user);
  if(receipt){if(receipt.fingerprint!==fingerprint)throw new ApiError('恢复请求的内容已改变，请重新预览。',409);return Response.json({snapshot:current,applied:true});}
  const plan=restorePlan(current.data,body.data,body.mode,body.requestId),preview={counts:plan.counts,warnings:plan.warnings,total:plan.total,workRevision:current.data.workRevision};
  if(body.preview)return Response.json(preview);
  if(body.reviewedRevision!==current.data.workRevision)throw new ApiError('工作空间有更新，请重新查看恢复预览。',409,{code:'RESTORE_REVIEW',preview,snapshot:current});
  if(!plan.total)return Response.json({snapshot:current,applied:false,empty:true});
  const data={...plan.data,workRevision:current.data.workRevision+1,history:[...current.data.history,{at:new Date().toISOString(),summary:'从备份恢复 '+plan.total+' 条记录'}].slice(-80)};
  if(await commitRestore(db,user,current,data,body.requestId,fingerprint))return Response.json({snapshot:{data,revision:current.revision+1},applied:true});
 }
 throw new ApiError('其他页面正在更新，请重试；已恢复的记录不会重复添加。',409);
}catch(e){return errorResponse(e)}}
