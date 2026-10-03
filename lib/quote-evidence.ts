// Qwen sometimes changes only spacing or punctuation when quoting the user.
// Align on every substantive code point, then retain the exact contiguous
// original span so later guards, audit entries, and memories see user words.
const ignorable=/[\p{White_Space}\p{P}]/u;

export function originalQuote(text:string,quote:string):string|null{
 const wanted=[...quote].filter(character=>!ignorable.test(character)).join('');
 if(!wanted)return null;
 if(text.includes(quote))return quote;
 let normalized='',index=0;
 const starts:number[]=[],ends:number[]=[];
 for(const character of text){
  if(!ignorable.test(character)){
   normalized+=character;
   // String#indexOf reports UTF-16 offsets; supplementary characters need
   // one source mapping entry for each code unit.
   for(let unit=0;unit<character.length;unit++){starts.push(index);ends.push(index+character.length)}
  }
  index+=character.length;
 }
 const at=normalized.indexOf(wanted);
 return at<0?null:text.slice(starts[at],ends[at+wanted.length-1]);
}
