import {z} from 'zod';
import {owner,guardOrigin,readJson,readWorkspace,binding,errorResponse,writeWorkspace,ApiError} from '@/lib/store';
import {readOperation,inverseOperations} from '@/lib/workspace-storage';

export async function POST(req:Request){try{
 guardOrigin(req);const user=await owner(req),{operationId,reviewedRevision}=z.object({operationId:z.string().min(8).max(94),reviewedRevision:z.number().int().optional()}).parse(await readJson(req));
 const db=binding(),undoId=operationId+'-undo',done=await readOperation(db,user,undoId);
 if(done?.status==='applied')return Response.json({...await readWorkspace(user),receipt:done});
 if(done)throw new ApiError('这次撤销已关闭，请打开记录核对后修改。',409);
 const receipt=await readOperation(db,user,operationId);
 if(!receipt?.undoable||!receipt.undoBaseline)throw new ApiError('这次操作无法直接撤销，请打开相关内容核对后修改。',409);
 const current=await readWorkspace(user);
 // No blanket overwrite: merge uses the committed after-state, including deletion-scope fingerprints.
 return Response.json(await writeWorkspace(user,current.revision,inverseOperations(receipt),undoId,'撤销上次修改',current.data.workRevision,receipt.undoBaseline,reviewedRevision));
}catch(e){return errorResponse(e)}}
