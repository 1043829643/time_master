// Convert browser recordings to Qwen's documented mono PCM WAV format.
export async function recordingToWav(blob:Blob):Promise<Blob>{
 const context=new AudioContext();let decoded:AudioBuffer;try{decoded=await context.decodeAudioData(await blob.arrayBuffer())}finally{await context.close()}
 if(decoded.duration>65)throw new Error('录音超过一分钟，请分段表达。');
 const target=new OfflineAudioContext(1,Math.ceil(decoded.duration*16000),16000),source=target.createBufferSource();source.buffer=decoded;source.connect(target.destination);source.start();const rendered=await target.startRendering(),pcm=rendered.getChannelData(0);
 let peak=0;for(const value of pcm)peak=Math.max(peak,Math.abs(value));if(peak<0.003)throw new Error('录音中没有检测到声音，请检查麦克风或重新录制。');
 const bytes=new ArrayBuffer(44+pcm.length*2),view=new DataView(bytes);const str=(at:number,s:string)=>{for(let i=0;i<s.length;i++)view.setUint8(at+i,s.charCodeAt(i))};str(0,'RIFF');view.setUint32(4,36+pcm.length*2,true);str(8,'WAVE');str(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,pcm.length*2,true);for(let i=0;i<pcm.length;i++){const x=Math.max(-1,Math.min(1,pcm[i]));view.setInt16(44+i*2,x<0?x*32768:x*32767,true)}return new Blob([bytes],{type:'audio/wav'});
}
