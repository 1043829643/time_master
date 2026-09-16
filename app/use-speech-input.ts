'use client';
import {useEffect,useRef,useState} from 'react';
import {recordingStore,RecordingOccupiedError,RecordingConsumedError,type SavedRecording} from '@/lib/recording-store';
import {recordingToWav} from '@/lib/audio';
import {requestJson,errorMessage} from '@/lib/api-client';
export function useSpeechInput(scope:string|undefined,onTranscript:(text:string,id:string)=>void|Promise<void>,beforeRecord:()=>void){
 const [phase,setPhase]=useState<'idle'|'permission'|'recording'|'recognizing'>('idle'),[seconds,setSeconds]=useState(0),[pending,setPending]=useState<SavedRecording|null>(null),[error,setError]=useState(''),[hydrated,setHydrated]=useState(false);
 const saved=useRef<SavedRecording|null>(null),generation=useRef(0),alive=useRef(false),flight=useRef<AbortController|null>(null),recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),timer=useRef<ReturnType<typeof setInterval>|null>(null),transcript=useRef(onTranscript);transcript.current=onTranscript;
 const [durable,setDurable]=useState(true),persistedId=useRef<string|null>(null);
 const retain=(value:SavedRecording|null)=>{saved.current=value;setPending(value)};
 useEffect(()=>{if(!scope)return;alive.current=true;let active=true;setHydrated(false);persistedId.current=null;recordingStore(scope,'read').then(value=>{if(active){persistedId.current=value?.id||null;retain(value);setDurable(true);setHydrated(true)}}).catch(()=>{if(active){setHydrated(true);setDurable(false);setError('此浏览器无法暂存录音，刷新前请完成识别。')}});return()=>{active=false;alive.current=false;generation.current++;flight.current?.abort();if(timer.current)clearInterval(timer.current);if(recorder.current?.state==='recording')recorder.current.stop();stream.current?.getTracks().forEach(t=>t.stop());}},[scope]);
 async function clear(value:SavedRecording){if(!scope)return;if(persistedId.current===value.id){await recordingStore(scope,'delete',value);persistedId.current=null;}}
 async function discard(){if(!scope||!saved.current)return;const token=generation.current;try{await clear(saved.current);if(alive.current&&token===generation.current){retain(null);setError('')}}catch{setError('未能清除暂存录音，请重试。')}}
 async function recognize(value:SavedRecording){
  if(navigator.locks){await navigator.locks.request('time-master-recording-'+scope,{ifAvailable:true},async lock=>{if(!lock){setError('另一个页面正在识别这段录音，请稍后重试。');return;}await recognizeLocked(value);});}
  else await recognizeLocked(value);
 }
 async function recognizeLocked(value:SavedRecording){
  if(!scope)return;const token=++generation.current,controller=new AbortController();flight.current=controller;setPhase('recognizing');setError('');retain(value);
  try{
   if(value.delivered){await clear(value);if(token===generation.current&&alive.current){retain(null);setError('');}return;}
   let storageAvailable=true;try{await recordingStore(scope,'save',value);persistedId.current=value.id;setDurable(true)}catch(e){storageAvailable=false;setDurable(false);if(e instanceof RecordingOccupiedError||e instanceof RecordingConsumedError)throw e;}
   let text=value.transcript;
   if(!text){const wav=await recordingToWav(value.blob);if(token!==generation.current)return;const audio=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(wav)});text=(await requestJson<{text:string}>('/api/qwen/asr',{audio},{signal:controller.signal})).text;}
   if(token!==generation.current||!alive.current)return;
   const completed={...value,transcript:text};retain(completed);if(storageAvailable)await recordingStore(scope,'save',completed);
   if(token!==generation.current||!alive.current)return;
   // The caller durably saves the text draft before the recording is removed.
   await transcript.current(text,value.id);const delivered={...completed,delivered:true};retain(delivered);if(storageAvailable)await recordingStore(scope,'save',delivered);
   await clear(value);if(token===generation.current&&alive.current){retain(null);setError('');}
  }catch(e){if(token===generation.current&&alive.current){if(e instanceof RecordingConsumedError){retain(null);persistedId.current=null;setError(e.message)}else setError(errorMessage(e)+' 录音仍保留，可以重试或下载。');}}
  finally{if(token===generation.current&&alive.current)setPhase('idle');}
 }
 function finish(){if(timer.current)clearInterval(timer.current);if(recorder.current?.state==='recording')recorder.current.stop();stream.current?.getTracks().forEach(t=>t.stop());}
 function cancel(){generation.current++;flight.current?.abort();if(timer.current)clearInterval(timer.current);if(recorder.current?.state==='recording')recorder.current.stop();stream.current?.getTracks().forEach(t=>t.stop());setPhase('idle');setSeconds(0);if(saved.current)setError('识别已停止，录音仍保留。');}
 async function record(){
  if(phase!=='idle'||!hydrated||saved.current)return;setError('');beforeRecord();if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){setError('当前浏览器不支持录音，请使用新版 Chrome / Edge，或直接输入。');return;}
  const token=++generation.current;setPhase('permission');
  try{const s=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});if(token!==generation.current){s.getTracks().forEach(t=>t.stop());return;}stream.current=s;const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'].find(m=>MediaRecorder.isTypeSupported(m)),rec=new MediaRecorder(s,mime?{mimeType:mime}:undefined);recorder.current=rec;const chunks:Blob[]=[];let bytes=0;
   rec.ondataavailable=e=>{if(e.data.size){chunks.push(e.data);bytes+=e.data.size;if(bytes>5500000)finish();}};
   rec.onerror=()=>{cancel();setError('录音被中断，请重新录制。')};
   rec.onstop=()=>{s.getTracks().forEach(t=>t.stop());if(token!==generation.current)return;const blob=new Blob(chunks,{type:rec.mimeType.split(';')[0]||'audio/webm'});if(blob.size<500){setError('录音太短，请再说一次。');setPhase('idle');return;}void recognize({id:crypto.randomUUID(),blob,createdAt:new Date().toISOString()});};
   rec.start(250);setPhase('recording');setSeconds(0);let elapsed=0;timer.current=setInterval(()=>{setSeconds(++elapsed);if(elapsed>=60)finish()},1000);
  }catch(e){if(token===generation.current){cancel();setError(e instanceof DOMException&&e.name==='NotAllowedError'?'麦克风权限未开启。可在地址栏授权，或直接输入。':'无法启用麦克风，请检查设备后重试。');}}
 }
 function download(){if(!saved.current)return;const url=URL.createObjectURL(saved.current.blob),link=document.createElement('a');link.href=url;link.download='暂存录音-'+saved.current.createdAt.slice(0,10)+(saved.current.blob.type.includes('wav')?'.wav':saved.current.blob.type.includes('mp4')?'.mp4':'.webm');link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 return {phase,seconds,pending,error,hydrated,durable,record,finish,cancel,discard,download,retry:()=>{if(saved.current&&phase==='idle')void recognize(saved.current);}};
}
