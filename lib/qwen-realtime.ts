/** WebRTC signalling stays on the server so the DashScope key never reaches the browser. */
export const REALTIME_MODEL = 'qwen-audio-3.0-realtime-plus';
export const REALTIME_OMNI_MODEL = 'qwen3.8-omni-flash-realtime';
export const MAX_SDP_BYTES = 128_000;

type RealtimeEnvironment = {
 QWEN_API_KEY?: string;
 QWEN_ACCESS_MODE?: string;
 QWEN_REALTIME_API_KEY?: string;
 QWEN_REALTIME_WORKSPACE_ID?: string;
 QWEN_REALTIME_MODEL?: string;
 QWEN_REALTIME_TEST_MODE?: string;
};

const validWorkspaceId = (id:string) => /^[A-Za-z0-9][A-Za-z0-9-]{0,62}[A-Za-z0-9]$/.test(id) || /^[A-Za-z0-9]$/.test(id);
const validModel = (model:string) => model===REALTIME_MODEL||model===REALTIME_OMNI_MODEL;

export function realtimeCredential(source:RealtimeEnvironment){
 // The subscription endpoint is an explicit, user-controlled test setting.
 // Normal site configuration never falls back to a subscription credential.
 if(source.QWEN_REALTIME_TEST_MODE==='token-plan'){
  if(source.QWEN_ACCESS_MODE!=='token-plan'&&source.QWEN_ACCESS_MODE!=='token-plan-local')return '';
  return source.QWEN_API_KEY?.trim()||'';
 }
 const key=(source.QWEN_REALTIME_API_KEY||(source.QWEN_ACCESS_MODE==='standard'?source.QWEN_API_KEY:''))?.trim()||'';
 return key.startsWith('sk-sp-')?'':key;
}

export function realtimeSettings(source:RealtimeEnvironment){
 const testMode=source.QWEN_REALTIME_TEST_MODE==='token-plan';
 const workspaceId=testMode?'token-plan':(source.QWEN_REALTIME_WORKSPACE_ID||'').trim();
 const model=(source.QWEN_REALTIME_MODEL||REALTIME_MODEL).trim();
 const key=realtimeCredential(source);
 const reason=testMode&&source.QWEN_ACCESS_MODE!=='token-plan'&&source.QWEN_ACCESS_MODE!=='token-plan-local'?'实时语音测试模式需要 QWEN_ACCESS_MODE=token-plan。':
  !key?testMode?'Token Plan 测试密钥尚未配置。':'请配置实时语音标准按量付费密钥 QWEN_REALTIME_API_KEY，或复用标准模式的 QWEN_API_KEY。':
  !validWorkspaceId(workspaceId)||!testMode&&workspaceId==='token-plan'?'请配置 QWEN_REALTIME_WORKSPACE_ID，填写标准百炼业务空间 ID。':
  !validModel(model)?'QWEN_REALTIME_MODEL 不支持，请选择 Qwen-Audio 3.0 Realtime Plus 或 Qwen3.8 Omni。':'';
 const configured=!reason;
 return {configured,workspaceId,model,voice:model===REALTIME_MODEL?'longanqian':'Tina',reason,testMode};
}

export function realtimeSignallingUrl(workspaceId:string,model=REALTIME_MODEL,testMode=false){
 if(!validWorkspaceId(workspaceId)||workspaceId==='token-plan'&&!testMode)throw new Error('Qwen 实时语音的业务空间 ID 未配置或格式无效。');
 if(!validModel(model))throw new Error('Qwen 实时语音模型未获支持。');
 return `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=${model}`;
}

export function validateSdp(sdp:string){
 return sdp.length>0&&new TextEncoder().encode(sdp).length<=MAX_SDP_BYTES&&
  /^v=0(?:\r?\n)/.test(sdp)&&/(?:^|\r?\n)m=audio\s/m.test(sdp)&&
  !sdp.includes('\0');
}

export async function readLimitedSdp(response:Request|Response){
 const reader=response.body?.getReader();
 if(!reader)throw new Error('SDP 内容为空。');
 const chunks:Uint8Array[]=[];let size=0;
 for(;;){
  const {done,value}=await reader.read();
  if(done)break;
  size+=value.byteLength;
  if(size>MAX_SDP_BYTES){await reader.cancel();throw new Error('SDP 内容过大。');}
  chunks.push(value);
 }
 const bytes=new Uint8Array(size);let offset=0;
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
