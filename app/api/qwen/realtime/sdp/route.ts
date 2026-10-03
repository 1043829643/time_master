import {env} from 'cloudflare:workers';
import {owner,errorResponse,ApiError} from '@/lib/store';
import {providerFailure} from '@/lib/provider-error';
import {MAX_SDP_BYTES,readLimitedSdp,realtimeCredential,realtimeSettings,realtimeSignallingUrl,validateSdp} from '@/lib/qwen-realtime';

export async function POST(req:Request){
 try{
  // A browser call is always same-origin. Requiring Origin here avoids handing
  // an authenticated WebRTC session to a cross-site form or non-browser relay.
  if(req.headers.get('origin')!==new URL(req.url).origin)throw new ApiError('请求来源不匹配。',403);
  await owner(req);
  if(req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/sdp')throw new ApiError('通话协商格式无效，请刷新页面重试。',415);
  const length=Number(req.headers.get('content-length')||0);
  if(length>MAX_SDP_BYTES)throw new ApiError('通话协商内容过大，请重试。',413);
  let offer:string;
  try{offer=await readLimitedSdp(req)}catch{throw new ApiError('通话协商内容无效或过大，请重试。',413);}
  if(!validateSdp(offer))throw new ApiError('通话协商内容无效，请重新打开语音频道。',400);
  const settings=realtimeSettings(env);
  if(!settings.configured)throw new ApiError(settings.reason,503);
  let response:Response;
  try{
   response=await fetch(realtimeSignallingUrl(settings.workspaceId,settings.model,settings.testMode),{
    method:'POST',headers:{Authorization:`Bearer ${realtimeCredential(env)}`,'Content-Type':'application/sdp'},
    body:offer,signal:AbortSignal.timeout(20000),redirect:'manual',
   });
  }catch{throw new ApiError('Qwen 实时语音连接超时或网络不可用，请重试。',502);}
  if(!response.ok){
   let payload:unknown;try{payload=await response.json()}catch{}
   const failure=providerFailure(response.status,payload,response.headers.get('x-request-id'));
   throw new ApiError(failure.message,failure.apiStatus,failure.details);
  }
  let answer:string;
  try{answer=await readLimitedSdp(response)}catch{throw new ApiError('Qwen 返回的通话协商内容无效，请重试。',502);}
  if(!validateSdp(answer))throw new ApiError('Qwen 返回的通话协商内容无效，请重试。',502);
  return new Response(answer,{status:200,headers:{'Content-Type':'application/sdp','Cache-Control':'no-store'}});
 }catch(error){return errorResponse(error);}
}
