import {env} from 'cloudflare:workers';
import {ApiError} from './store';
export function qwenConfig(){const localTest=env.QWEN_ACCESS_MODE==='token-plan-local',tokenPlan=localTest||env.QWEN_ACCESS_MODE==='token-plan';return {configured:!!env.QWEN_API_KEY,tokenPlan,localTest,chat:env.QWEN_CHAT_MODEL||(tokenPlan?'qwen3.8-flash':'qwen-plus'),asr:env.QWEN_ASR_MODEL||(tokenPlan?'qwen-audio-3.0-asr-flash':'qwen3-asr-flash'),tts:env.QWEN_TTS_MODEL||(tokenPlan?'qwen-audio-3.0-tts-plus':'qwen3-tts-flash'),voice:env.QWEN_VOICE||(tokenPlan?'longanhuan_v3.6':'Cherry')};}
export async function qwen(body:unknown,kind:'chat'|'tts'|'asr'='chat',timeoutMs=60000){
 if(!env.QWEN_API_KEY)throw new ApiError('Qwen 尚未配置，请先连接模型后再使用语音和对话。',503);
 const config=qwenConfig();
 const host=config.tokenPlan?'https://token-plan.cn-beijing.maas.aliyuncs.com':'https://dashscope.aliyuncs.com';
 const path=config.tokenPlan&&kind==='tts'?'/api/v1/services/audio/tts/SpeechSynthesizer':kind==='tts'||config.tokenPlan&&kind==='asr'?'/api/v1/services/aigc/multimodal-generation/generation':'/compatible-mode/v1/chat/completions';
 const url=host+path;
 let response:Response;try{response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${env.QWEN_API_KEY}`,'Content-Type':'application/json',...(config.tokenPlan&&kind==='asr'?{'X-DashScope-SSE':'disable'}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)})}catch{throw new ApiError('Qwen 连接超时或网络不可用，请重试。',502)}
 if(!response.ok){const status=response.status;throw new ApiError(status===401||status===403?'Qwen 鉴权失败，请检查密钥、地域与接入方式是否匹配。':status===429?'Qwen 请求频繁或额度不足，请稍后重试。':`Qwen 服务暂时未完成请求（${status}）。`,502)}
 try{return await response.json() as any}catch{throw new ApiError('Qwen 返回格式无效，请重试。',502)}
}
