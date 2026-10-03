'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {RealtimeTurnBuffer} from '@/lib/realtime-turn-buffer';
import {realtimeSessionUpdate} from '@/lib/realtime-voice-protocol';
import {RealtimeVoiceDrain} from '@/lib/realtime-voice-drain';

type VoiceStatus='idle'|'connecting'|'listening'|'muted'|'ending'|'error';
type RealtimeConfig={configured:boolean;model:string;reason?:string};
type ModelEvent={type?:string;item_id?:string;event_id?:string;text?:string;stash?:string;transcript?:string;error?:{message?:string;code?:string}};
type Options={onFinalUtterance:(text:string,turnId:string)=>void|Promise<void>;onError?:(message:string)=>void};
type Session={
 pc:RTCPeerConnection;sender:RTCRtpSender;controller:AbortController;channels:Set<RTCDataChannel>;
 stream:MediaStream|null;eventChannel:RTCDataChannel|null;buffer:RealtimeTurnBuffer;drain:RealtimeVoiceDrain;
 created:boolean;updateSent:boolean;ready:boolean;muted:boolean;responding:boolean;closed:boolean;draining:boolean;
 quietTimer:ReturnType<typeof setTimeout>|null;disconnectTimer:ReturnType<typeof setTimeout>|null;
 readyTimer:ReturnType<typeof setTimeout>|null;drainTimer:ReturnType<typeof setTimeout>|null;
 settleTimer:ReturnType<typeof setTimeout>|null;stopMicTimer:ReturnType<typeof setTimeout>|null;
 drainPromise:Promise<void>|null;resolveDrain:(()=>void)|null;
 resolveReady:()=>void;rejectReady:(e:Error)=>void;
};

// The provider uses VAD to finish an item, but a person may immediately correct
// it. Send a single complete turn after a short quiet period, never a delta.
const QUIET_MS=1800;
const READY_MS=45000;
const DRAIN_MS=4500;
const DRAIN_SETTLE_MS=500;
const SILENT_TAIL_MS=1100;

function description(error:unknown){
 if(error instanceof DOMException&&error.name==='NotAllowedError')return '麦克风权限未开启。可在地址栏授权后重试。';
 if(error instanceof Error&&error.message)return error.message;
 return '实时语音暂时无法连接，请重试。';
}

async function waitForIce(pc:RTCPeerConnection,signal:AbortSignal){
 if(pc.iceGatheringState==='complete')return;
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>finish(new Error('语音连接准备超时，请重试。')),15000);
  const finish=(error?:Error)=>{clearTimeout(timer);pc.removeEventListener('icegatheringstatechange',check);signal.removeEventListener('abort',cancel);if(error)reject(error);else resolve()};
  const check=()=>{if(pc.iceGatheringState==='complete')finish()};
  const cancel=()=>finish(new Error('语音通话已结束。'));
  pc.addEventListener('icegatheringstatechange',check);signal.addEventListener('abort',cancel,{once:true});
  if(signal.aborted)cancel();else check();
 });
}

export function useRealtimeVoice({onFinalUtterance,onError}:Options){
 const [status,setStatus]=useState<VoiceStatus>('idle'),[partial,setPartial]=useState(''),[error,setError]=useState(''),[muted,setMuted]=useState(false);
 const sessionRef=useRef<Session|null>(null),mounted=useRef(true),finalRef=useRef(onFinalUtterance),errorRef=useRef(onError);
 const startSequence=useRef(0),preflight=useRef<AbortController|null>(null),startPromise=useRef<Promise<boolean>|null>(null);
 useEffect(()=>{finalRef.current=onFinalUtterance;errorRef.current=onError},[onFinalUtterance,onError]);

 const close=useCallback((session:Session)=>{
  if(session.closed)return;
  session.closed=true;session.controller.abort();
  if(session.quietTimer)clearTimeout(session.quietTimer);
  if(session.disconnectTimer)clearTimeout(session.disconnectTimer);
  if(session.readyTimer)clearTimeout(session.readyTimer);
  if(session.drainTimer)clearTimeout(session.drainTimer);
  if(session.settleTimer)clearTimeout(session.settleTimer);
  if(session.stopMicTimer)clearTimeout(session.stopMicTimer);
  session.rejectReady(new Error('语音通话已结束。'));
  session.stream?.getTracks().forEach(track=>track.stop());
  session.channels.forEach(channel=>{try{channel.close()}catch{}});
  try{session.pc.close()}catch{}
  session.buffer.clear();
  if(sessionRef.current===session)sessionRef.current=null;
  session.resolveDrain?.();session.resolveDrain=null;
 },[]);

 const flush=useCallback((session:Session)=>{
  if(session.quietTimer){clearTimeout(session.quietTimer);session.quietTimer=null}
  if(session.closed)return;
  const text=session.buffer.flush();if(!text)return;
  if(mounted.current)setPartial(session.buffer.unfinishedPreview());
  const id=crypto.randomUUID();
  const failed=(cause:unknown)=>{
   // The caller owns durable outbox storage. Keep the recognized words visible
   // if that storage fails rather than claiming the utterance was sent.
   if(mounted.current){setPartial(text);const message='听清了这句话，但没有暂存成功：'+description(cause);setError(message);errorRef.current?.(message)}
  };
  try{void Promise.resolve(finalRef.current(text,id)).catch(failed)}catch(cause){failed(cause)}
 },[]);

 const terminate=useCallback((session:Session,reason='',failure=false)=>{
  if(session.closed)return;
  // Only completed transcriptions are sent to the durable chat outbox. Keep
  // the last unfinished words visible so an interrupted instruction is never
  // mistaken for a submitted one.
  const unfinished=session.buffer.unfinishedPreview();
  const lostFinal=session.drain.awaitingFinal||!!unfinished;
  flush(session);
  close(session);
  const notice=[reason,lostFinal?'最后一句尚未提交，请重新说一遍。':''].filter(Boolean).join(' ');
  if(mounted.current){setStatus(failure?'error':'idle');setPartial(unfinished);setError(notice);setMuted(false)}
  if(notice)errorRef.current?.(notice);
 },[close,flush]);

 const fail=useCallback((session:Session,message:string)=>{
  if(sessionRef.current!==session||session.closed)return;
  terminate(session,message,true);
 },[terminate]);

 const end=useCallback(():Promise<void>=>{
  startSequence.current++;preflight.current?.abort();preflight.current=null;startPromise.current=null;
  const session=sessionRef.current;
  if(!session){if(mounted.current){setStatus('idle');setPartial('');setError('');setMuted(false)}return Promise.resolve()}
  if(session.draining)return session.drainPromise||Promise.resolve();
  if(!session.ready){terminate(session);return Promise.resolve()}
  session.draining=true;session.drain.begin();
  if(session.quietTimer){clearTimeout(session.quietTimer);session.quietTimer=null}
  const track=session.stream?.getAudioTracks()[0];if(track)track.enabled=false;
  session.muted=true;
  if(mounted.current){setStatus('ending');setMuted(true)}
  session.drainPromise=new Promise<void>(resolve=>{session.resolveDrain=resolve});
  // A short silent tail lets provider VAD complete the phrase already sent.
  // The track sends silence immediately, then releases the microphone while
  // the DataChannel remains open for a bounded final-transcript drain.
  session.stopMicTimer=setTimeout(()=>{
   if(session.closed)return;
   void session.sender.replaceTrack(null).catch(()=>{});
   session.stream?.getTracks().forEach(t=>t.stop());
  },SILENT_TAIL_MS);
  session.drainTimer=setTimeout(()=>terminate(session),DRAIN_MS);
  return session.drainPromise;
 },[terminate]);

 const stopNow=useCallback((reason='')=>{
  startSequence.current++;preflight.current?.abort();preflight.current=null;startPromise.current=null;
  const session=sessionRef.current;
  if(session)terminate(session,reason);
  else if(mounted.current){setStatus('idle');setMuted(false)}
 },[terminate]);

 const mute=useCallback((next?:boolean)=>{
  const session=sessionRef.current;if(!session||session.closed||session.draining)return;
  session.muted=next??!session.muted;
  const track=session.stream?.getAudioTracks()[0];if(track)track.enabled=!session.muted;
  if(mounted.current){setMuted(session.muted);if(session.ready)setStatus(session.muted?'muted':'listening')}
 },[]);

 const interrupt=useCallback(()=>{
  const session=sessionRef.current;if(!session||session.closed||!session.responding)return;
  const channel=session.eventChannel;if(channel?.readyState==='open'){
   channel.send(JSON.stringify({type:'response.cancel',event_id:'event_'+crypto.randomUUID()}));
   session.responding=false;
  }
 },[]);

 const connect=useCallback(async():Promise<boolean>=>{
  const previous=sessionRef.current;
  if(previous&&!previous.closed){
   if(previous.draining)await previous.drainPromise;
   else return previous.ready;
  }
  if(typeof RTCPeerConnection==='undefined'||!navigator.mediaDevices?.getUserMedia){
   const message='当前浏览器不支持实时语音通话，请使用新版 Chrome 或 Edge。';setStatus('error');setError(message);errorRef.current?.(message);return false;
  }
  setStatus('connecting');setError('');setPartial('');setMuted(false);
  const sequence=++startSequence.current,check=new AbortController();preflight.current=check;
  const checkTimer=setTimeout(()=>check.abort(),12000);
  let session:Session|undefined;
  try{
   const configResponse=await fetch('/api/qwen/status',{cache:'no-store',credentials:'same-origin',signal:check.signal});
   if(!configResponse.ok)throw new Error('暂时无法检查实时语音配置，请重试。');
   const config=(await configResponse.json() as {realtime?:RealtimeConfig}).realtime;
   clearTimeout(checkTimer);
   if(sequence!==startSequence.current)return false;
   if(!config?.configured)throw new Error(config?.reason||'实时语音频道尚未配置。');
   if(!/^qwen(?:3\.8-omni|\-audio)-/.test(config.model))throw new Error('当前实时语音模型不受支持。');
   if(!mounted.current)return false;
   const pc=new RTCPeerConnection({iceServers:[]}),controller=new AbortController();
   const transceiver=pc.addTransceiver('audio',{direction:'sendrecv'});
   let resolveReady!:()=>void,rejectReady!:(error:Error)=>void;
   const readyPromise=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject});
   // An explicit End can occur during media permission or SDP exchange.
   // Attach a handler now so its rejection is never left unobserved.
   void readyPromise.catch(()=>{});
   session={pc,sender:transceiver.sender,controller,channels:new Set(),stream:null,eventChannel:null,buffer:new RealtimeTurnBuffer(),drain:new RealtimeVoiceDrain(),created:false,updateSent:false,ready:false,muted:false,responding:false,closed:false,draining:false,quietTimer:null,disconnectTimer:null,readyTimer:null,drainTimer:null,settleTimer:null,stopMicTimer:null,drainPromise:null,resolveDrain:null,resolveReady,rejectReady};
   sessionRef.current=session;
   const current=session;
   current.readyTimer=setTimeout(()=>fail(current,'实时语音初始化超时，请重试。'),READY_MS);
   const send=(channel:RTCDataChannel,event:unknown)=>{
    if(current.closed||pc.connectionState!=='connected'||channel.readyState!=='open')return false;
    channel.send(JSON.stringify(event));return true;
   };
   const tryConfigure=()=>{
    if(current.closed||!current.created||current.updateSent||pc.connectionState!=='connected'||current.eventChannel?.readyState!=='open')return;
    current.updateSent=send(current.eventChannel,realtimeSessionUpdate(config.model,'event_'+crypto.randomUUID()));
   };
   const scheduleFlush=()=>{
    if(current.draining){
     if(current.settleTimer){clearTimeout(current.settleTimer);current.settleTimer=null}
     if(current.drain.canSettle)current.settleTimer=setTimeout(()=>terminate(current),DRAIN_SETTLE_MS);
     return;
    }
    if(current.quietTimer)clearTimeout(current.quietTimer);
    current.quietTimer=setTimeout(()=>flush(current),QUIET_MS);
   };
   const onEvent=(event:ModelEvent,channel:RTCDataChannel)=>{
    if(current.closed)return;
    switch(event.type){
     case 'session.created':current.created=true;current.eventChannel=channel;tryConfigure();break;
     case 'session.updated':
      if(!current.updateSent||current.ready)return;
      current.ready=true;if(current.readyTimer)clearTimeout(current.readyTimer);
      void current.sender.replaceTrack(current.stream?.getAudioTracks()[0]||null).then(()=>{
       if(current.closed)return;
       const track=current.stream?.getAudioTracks()[0];if(track)track.enabled=!current.muted;
       if(mounted.current){setStatus(current.muted?'muted':'listening');setMuted(current.muted);setError('')}
       current.resolveReady();
      }).catch(cause=>fail(current,'麦克风无法接入实时频道：'+description(cause)));
      break;
     case 'input_audio_buffer.speech_started':
      if(event.item_id)current.drain.speech(event.item_id);
      if(current.settleTimer){clearTimeout(current.settleTimer);current.settleTimer=null}
      if(mounted.current&&!current.draining)setError('');
      break;
     case 'conversation.item.input_audio_transcription.delta':{
      const id=event.item_id||event.event_id;if(!id)return;
      current.drain.partial(id);
      if(current.settleTimer){clearTimeout(current.settleTimer);current.settleTimer=null}
      const preview=current.buffer.partial(id,event.text||'',event.stash||'');
      if(mounted.current)setPartial(preview);
      break;
     }
     case 'conversation.item.input_audio_transcription.completed':{
      const id=event.item_id||event.event_id;if(!id)return;
      current.drain.completed(id);
      if(current.buffer.complete(id,event.transcript||'')){
       if(mounted.current)setPartial(current.buffer.preview());
       scheduleFlush();
      }
      break;
     }
     case 'conversation.item.input_audio_transcription.failed':{
      const id=event.item_id||event.event_id;
      if(id){current.drain.failed(id);if(mounted.current)setPartial(current.buffer.failed(id))}
      if(current.draining&&current.drain.canSettle)scheduleFlush();
      const message='刚才那句没有识别清楚，请再说一次。';if(mounted.current){setError(message);errorRef.current?.(message)}
      break;
     }
     case 'response.created':current.responding=true;break;
     case 'response.done':current.responding=false;break;
     case 'error':fail(current,event.error?.message?'实时语音连接出错：'+event.error.message:'实时语音连接出错，请重试。');break;
    }
   };
   const bind=(channel:RTCDataChannel)=>{
    current.channels.add(channel);
    channel.onopen=()=>tryConfigure();
    channel.onmessage=message=>{if(typeof message.data!=='string')return;try{const event=JSON.parse(message.data) as ModelEvent;if(event&&typeof event.type==='string')onEvent(event,channel)}catch{}};
    channel.onclose=()=>{if(current.closed)return;if(current.ready&&channel===current.eventChannel)fail(current,'实时语音连接已断开，请重新开始通话。')};
   };
   pc.ondatachannel=event=>bind(event.channel);
   bind(pc.createDataChannel('oai-events'));
   // The model may negotiate a remote audio track. Never attach it to an audio
   // element: only the verified /api/qwen/chat reply may be spoken to users.
   pc.ontrack=event=>{event.track.enabled=false};
   pc.onconnectionstatechange=()=>{
    if(current.closed)return;
    if(pc.connectionState==='connected'){
     if(current.disconnectTimer){clearTimeout(current.disconnectTimer);current.disconnectTimer=null}
     tryConfigure();
    }else if(pc.connectionState==='failed'||pc.connectionState==='closed')fail(current,'实时语音连接已断开，请重新开始通话。');
    else if(pc.connectionState==='disconnected'&&!current.disconnectTimer)current.disconnectTimer=setTimeout(()=>fail(current,'实时语音连接已断开，请重新开始通话。'),5000);
   };
   const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
   if(current.closed){stream.getTracks().forEach(track=>track.stop());return false}
   current.stream=stream;
   stream.getAudioTracks()[0]?.addEventListener('ended',()=>fail(current,'麦克风已断开，语音通话已结束。'),{once:true});
   const offer=await pc.createOffer();await pc.setLocalDescription(offer);
   await waitForIce(pc,controller.signal);
   if(current.closed)return false;
   const sdp=pc.localDescription?.sdp;if(!sdp)throw new Error('未能生成语音连接信息，请重试。');
   const answer=await fetch('/api/qwen/realtime/sdp',{method:'POST',headers:{'Content-Type':'application/sdp'},body:sdp,credentials:'same-origin',cache:'no-store',signal:controller.signal});
   if(!answer.ok){let message='Qwen 实时语音暂时无法连接，请重试。';try{const body=await answer.json() as {error?:string};if(body.error)message=body.error}catch{}throw new Error(message)}
   const answerSdp=(await answer.text()).trim().replace(/\r?\n/g,'\r\n')+'\r\n';
   if(current.closed)return false;
   await pc.setRemoteDescription({type:'answer',sdp:answerSdp});
   await readyPromise;
   return !current.closed&&current.ready;
  }catch(cause){
   if(session?.closed||sequence!==startSequence.current)return false;
   const message=check.signal.aborted?'实时语音配置检查超时，请重试。':description(cause);
   if(session)fail(session,message);
   else if(mounted.current){setStatus('error');setError(message);errorRef.current?.(message)}
   return false;
  }finally{clearTimeout(checkTimer);if(preflight.current===check)preflight.current=null}
 },[fail,flush,terminate]);

 const start=useCallback(()=>{
  if(startPromise.current)return startPromise.current;
  const attempt=connect();startPromise.current=attempt;
  void attempt.finally(()=>{if(startPromise.current===attempt)startPromise.current=null});
  return attempt;
 },[connect]);

 useEffect(()=>{
  mounted.current=true;
  const stop=()=>stopNow('语音通话已中断。');
  const hidden=()=>{if(document.visibilityState==='hidden')stop()};
  window.addEventListener('pagehide',stop);document.addEventListener('visibilitychange',hidden);
  return()=>{mounted.current=false;stop();window.removeEventListener('pagehide',stop);document.removeEventListener('visibilitychange',hidden)};
 },[stopNow]);

 return {status,partial,error,start,end,mute,interrupt,muted,active:status==='connecting'||status==='listening'||status==='muted'||status==='ending',
  // Canonical replies are spoken by the existing /api/qwen/tts path. Sending
  // them into Realtime as a model prompt could paraphrase or hallucinate them.
  speak:()=>{}};
}
