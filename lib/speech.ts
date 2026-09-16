// Preserve every character, split near sentences, and never split a surrogate pair.
export function speechChunks(text:string,limit=540){
 const chunks:string[]=[];let remaining=text.trim();
 while(remaining.length){
  if(remaining.length<=limit){chunks.push(remaining);break;}
  let end=limit;if(/[\uD800-\uDBFF]/.test(remaining[end-1]))end--;
  const prefix=remaining.slice(0,end),breaks=[...prefix.matchAll(/[。！？!?；;\n]/g)];
  const last=breaks.at(-1);if(last&&last.index!>=limit/2)end=last.index!+1;
  chunks.push(remaining.slice(0,end));remaining=remaining.slice(end);
 }
 return chunks;
}
