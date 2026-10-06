/**
 * Qwen can finish one transcription item while the person is only pausing,
 * thinking, or about to correct it. A completed item is therefore a fragment,
 * not an instruction to execute. This buffer waits for a quiet interval after
 * every outstanding item has a final transcript.
 */
type TimerDriver={set:(callback:()=>void,delayMs:number)=>unknown;clear:(timer:unknown)=>void};
type Options={onReady?:()=>void;quietMs?:number;timers?:TimerDriver};
type Segment={partial:string;final:string|null;pending:boolean};

const defaultTimers:TimerDriver={
 set:(callback,delayMs)=>setTimeout(callback,delayMs),
 clear:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>),
};

// A human pause between thoughts is often longer than the provider's VAD gap.
// Keep the automatic action boundary deliberately more conservative.
export const REALTIME_QUIET_MS=4000;

// ASR may add a full stop to an unfinished thought (for example "你好，我要。").
// Punctuation alone is not evidence that an instruction is complete.
export function needsMoreSpeech(text:string){
 const tail=text.replace(/[\s，。、；：！？,.!?;:]+$/gu,'').trim();
 return /(?:我要|我想|我想要|我需要|我打算|我准备|帮我|给我|让我|请帮我|先帮我|先把|再把|然后|但是|因为|还有|关于|比如|就是|这个|那个|一份)$/u.test(tail);
}

export class RealtimeTurnBuffer {
 private readonly segments=new Map<string,Segment>();
 private readonly seen=new Set<string>();
 private readonly seenOrder:string[]=[];
 private readonly onReady:()=>void;
 private readonly quietMs:number;
 private readonly timers:TimerDriver;
 private timer:unknown|null=null;

 constructor(options:Options={}){
  this.onReady=options.onReady||(()=>{});
  this.quietMs=options.quietMs??REALTIME_QUIET_MS;
  this.timers=options.timers||defaultTimers;
 }

 private get(itemId:string){
  let item=this.segments.get(itemId);
  if(!item){item={partial:'',final:null,pending:true};this.segments.set(itemId,item)}
  return item;
 }

 private remember(itemId:string){
  this.seen.add(itemId);this.seenOrder.push(itemId);
  if(this.seenOrder.length>512)this.seen.delete(this.seenOrder.shift()!);
 }

 preview(){return [...this.segments.values()].map(item=>item.final??item.partial).filter(Boolean).join(' ').trim()}
 unfinishedPreview(){return [...this.segments.values()].filter(item=>item.pending).map(item=>item.partial).filter(Boolean).join(' ').trim()}
 hasUnfinished(){return [...this.segments.values()].some(item=>item.pending)}
 hasIncompleteCandidate(){
  const completed=[...this.segments.values()].map(item=>item.final).filter((value):value is string=>!!value).join(' ');
  return !!completed&&needsMoreSpeech(completed);
 }

 cancelAutoCommit(){
  if(this.timer!==null){this.timers.clear(this.timer);this.timer=null}
 }

 speechStarted(itemId:string){
  this.cancelAutoCommit();
  if(itemId&&!this.seen.has(itemId))this.get(itemId).pending=true;
 }

 partial(itemId:string,text:string,stash:string){
  this.cancelAutoCommit();
  if(this.seen.has(itemId))return this.preview();
  const item=this.get(itemId);
  item.partial=text+stash;item.pending=true;
  return this.preview();
 }

 private canAutoCommit(){
  let completed=false;
  for(const item of this.segments.values()){
   if(item.pending)return false;
   if(item.final)completed=true;
  }
  return completed&&!this.hasIncompleteCandidate();
 }

 private schedule(){
  this.cancelAutoCommit();
  if(!this.canAutoCommit())return;
  this.timer=this.timers.set(()=>{
   this.timer=null;
   // The timer may race with a new speech-start or partial event. Never send
   // an earlier completed fragment while a newer item remains unfinished.
   if(this.canAutoCommit())this.onReady();
  },this.quietMs);
 }

 complete(itemId:string,transcript:string){
  if(this.seen.has(itemId))return false;
  this.remember(itemId);
  const item=this.get(itemId),value=transcript.trim();
  item.partial='';item.final=value;item.pending=false;
  this.schedule();
  return !!value;
 }

 failed(itemId:string){
  if(this.seen.has(itemId))return this.preview();
  this.cancelAutoCommit();
  this.remember(itemId);
  // A failed item may have contained a correction to earlier completed words.
  // Discard the whole unsent candidate so ending the call cannot execute only
  // the surviving first half. The next spoken item starts a fresh candidate.
  this.segments.clear();
  return this.preview();
 }

 // Qwen smart_turn marks fillers and background sound as turn_invalid. They
 // are not missing instructions; discard them and resume the previous quiet
 // interval if a real completed candidate was waiting.
 invalid(itemId:string){
  this.cancelAutoCommit();
  if(!this.seen.has(itemId))this.remember(itemId);
  this.segments.delete(itemId);
  this.schedule();
  return this.preview();
 }

 // Explicit end may submit completed fragments while leaving a later partial
 // visible for review. Automatic submission always requires all items final.
 flush(){
  this.cancelAutoCommit();
  const complete:string[]=[];
  for(const [id,item] of this.segments){
   if(item.pending)continue;
   if(item.final)complete.push(item.final);
   this.segments.delete(id);
  }
  return complete.join(' ').trim();
 }

 clear(){this.cancelAutoCommit();this.segments.clear();this.seen.clear();this.seenOrder.length=0}
}
