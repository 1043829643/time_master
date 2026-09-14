import {env} from 'cloudflare:workers';
import {ApiError} from './store';
export function qwenConfig(){return {configured:!!env.QWEN_API_KEY,chat:env.QWEN_CHAT_MODEL||'qwen-plus',asr:env.QWEN_ASR_MODEL||'qwen3-asr-flash',tts:env.QWEN_TTS_MODEL||'qwen3-tts-flash'};}
export async function qwen(body:unknown,kind:'chat'|'tts'='chat'){
 if(!env.QWEN_API_KEY)throw new ApiError('请先在服务端配置百炼通用 API Key（北京地域），即可使用真实 Qwen 语音和对话。',503);
 const url=kind==='tts'?'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation':'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
 let response:Response;try{response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${env.QWEN_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(60000)})}catch{throw new ApiError('Qwen 连接超时或网络不可用，请重试。',502)}
 if(!response.ok){const status=response.status;throw new ApiError(status===401||status===403?'Qwen 鉴权失败，请检查密钥地域、权限及是否为通用 API Key。':status===429?'Qwen 请求频繁或额度不足，请稍后重试。':`Qwen 服务暂时未完成请求（${status}）。`,502)}
 try{return await response.json() as any}catch{throw new ApiError('Qwen 返回格式无效，请重试。',502)}
}
