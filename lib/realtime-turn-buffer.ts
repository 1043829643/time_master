/**
 * A short pause can split one human correction into several provider items.
 * Keep completed items together until the caller's quiet-period timer fires.
 * Only completed input transcriptions may be submitted as user turns.
 */
export class RealtimeTurnBuffer {
 private seen=new Set<string>();
 private seenOrder:string[]=[];
 private fragments:string[]=[];
 private partials=new Map<string,string>();

 preview(){return [...this.fragments,...this.partials.values()].filter(Boolean).join(' ').trim()}
 unfinishedPreview(){return [...this.partials.values()].filter(Boolean).join(' ').trim()}

 partial(itemId:string,text:string,stash:string){
  if(this.seen.has(itemId))return this.preview();
  this.partials.set(itemId,text+stash);
  return this.preview();
 }

 complete(itemId:string,transcript:string){
  if(this.seen.has(itemId))return false;
  this.seen.add(itemId);this.seenOrder.push(itemId);
  if(this.seenOrder.length>512)this.seen.delete(this.seenOrder.shift()!);
  this.partials.delete(itemId);
  const value=transcript.trim();if(value)this.fragments.push(value);
  return !!value;
 }

 failed(itemId:string){this.partials.delete(itemId);return this.preview()}

 flush(){const text=this.fragments.join(' ').trim();this.fragments=[];return text}

 clear(){this.fragments=[];this.partials.clear()}
}
