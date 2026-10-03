/** Only short provider identifiers cross the API boundary; response bodies may contain user input. */
const safeIdentifier=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/.test(value)?value:'';

export function providerFailure(status:number,body:unknown,headerRequestId?:string|null){
 const value=body&&typeof body==='object'?body as Record<string,unknown>:{};
 const error=value.error&&typeof value.error==='object'?value.error as Record<string,unknown>:{};
 const code=safeIdentifier(value.code)||safeIdentifier(error.code);
 const requestId=safeIdentifier(value.request_id)||safeIdentifier(value.requestId)||safeIdentifier(headerRequestId);
 const reason=status===401||status===403?'Qwen 鉴权失败，请检查密钥、地域与接入方式是否匹配。':status===429?'Qwen 请求频繁或额度不足，请稍后重试。':`Qwen 服务暂时未完成请求（${status}）。`;
 return {message:reason+[code?'错误码 '+code:'',requestId?'请求号 '+requestId:''].filter(Boolean).join(' · '),apiStatus:[401,403,429].includes(status)?424:502,details:{providerStatus:status,...(code?{providerCode:code}:{}),...(requestId?{providerRequestId:requestId}:{})}};
}
