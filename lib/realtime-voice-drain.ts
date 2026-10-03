/** Tracks provider items that may still yield a final transcript after Stop. */
export class RealtimeVoiceDrain {
 private pending=new Set<string>();
 private ending=false;
 private finalAfterEnd=false;

 speech(itemId:string){if(itemId)this.pending.add(itemId)}
 partial(itemId:string){if(itemId)this.pending.add(itemId)}
 completed(itemId:string){this.pending.delete(itemId);if(this.ending)this.finalAfterEnd=true}
 failed(itemId:string){this.pending.delete(itemId)}
 begin(){this.ending=true}
 get awaitingFinal(){return this.pending.size>0}
 get canSettle(){return this.ending&&this.finalAfterEnd&&!this.awaitingFinal}
}
