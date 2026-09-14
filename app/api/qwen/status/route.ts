import {qwenConfig} from '@/lib/qwen';
import {owner,errorResponse} from '@/lib/store';
export async function GET(req:Request){try{await owner(req);return Response.json(qwenConfig(),{headers:{'Cache-Control':'no-store'}})}catch(e){return errorResponse(e)}}
