// Retain the browser recording before waiting for another tab to finish.
// A cancelled or unmounted recording must not start processing when the lock opens.
export async function runAfterRecordingLock(
 retain:()=>void,
 acquire:(run:()=>Promise<void>)=>Promise<void>,
 active:()=>boolean,
 process:()=>Promise<void>,
){
 retain();
 await acquire(async()=>{if(active())await process()});
}
