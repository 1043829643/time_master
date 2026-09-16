export class ClientError extends Error {
 status:number;
 retryable:boolean;
 details:any;
 constructor(message:string,status=0,retryable=false,details?:unknown){super(message);this.name='ClientError';this.status=status;this.retryable=retryable;this.details=details;}
}
type Options={signal?:AbortSignal;retries?:number;timeoutMs?:number};
export function errorMessage(error:unknown){
 if(error instanceof ClientError)return error.message;
 if(error instanceof Error&&/Failed to fetch|fetch failed|NetworkError|Load failed|network/i.test(error.message))return '网络连接中断，请检查网络后重试。';
 return error instanceof Error?error.message:'请求未完成，请稍后重试。';
}
async function pause(ms:number,signal?:AbortSignal){
 if(signal?.aborted)throw new DOMException('已取消','AbortError');
 await new Promise<void>((resolve,reject)=>{const done=()=>{signal?.removeEventListener('abort',cancel);resolve()};const timer=setTimeout(done,ms);const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(new DOMException('已取消','AbortError'))};signal?.addEventListener('abort',cancel,{once:true})});
}
async function request<T>(url:string,body:unknown|undefined,parse:(r:Response)=>Promise<T>,options:Options={}){
 const retries=options.retries??1;
 for(let attempt=0;;attempt++){
  const controller=new AbortController();let timedOut=false;
  const cancel=()=>controller.abort();options.signal?.addEventListener('abort',cancel,{once:true});if(options.signal?.aborted)controller.abort();
  const timer=setTimeout(()=>{timedOut=true;controller.abort()},options.timeoutMs??75000);
  try{
   const r=await fetch(url,{method:body===undefined?'GET':'POST',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'same-origin',signal:controller.signal});
   const isJson=r.headers.get('content-type')?.includes('application/json');
   if(r.redirected&&!isJson)throw new ClientError('登录状态已失效，请刷新页面重新登录；未发送的内容会保留。',401);
   if(!r.ok){let message='',details:unknown;if(isJson){try{const failure=await r.json() as {error?:string;details?:unknown};message=failure.error||'';details=failure.details}catch{}}
    if(r.status===401)message='登录状态已失效，请刷新页面重新登录；未发送的内容会保留。';
    throw new ClientError(message||'连接暂时不稳定，请稍后重试。',r.status,[408,502,503,504].includes(r.status),details);}
   return await parse(r);
  }catch(error){
   if(options.signal?.aborted)throw new DOMException('已取消','AbortError');
   const offline=typeof navigator!=='undefined'&&navigator.onLine===false;
   const failure=error instanceof ClientError?error:new ClientError(offline?'网络已断开，请联网后重试。':timedOut?'等待回复超时，请重试。':'连接中断，暂时没有收到完整回复，请重试。',0,!offline);
   if(!failure.retryable||attempt>=retries)throw failure;
  }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel)}
  await pause(500*(attempt+1),options.signal);
 }
}
export function requestJson<T=any>(url:string,body?:unknown,options:Options={}){return request(url,body,async r=>{
 if(!r.headers.get('content-type')?.includes('application/json'))throw new ClientError('没有收到有效回复，请刷新页面检查登录状态；输入会保留。',401);
 return await r.json() as T;
},options)}
export function requestAudio(url:string,body:unknown,options:Options={}){return request(url,body,r=>r.blob(),options)}
