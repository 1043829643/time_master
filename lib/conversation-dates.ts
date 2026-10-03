const weekdays=['一','二','三','四','五','六','日'];
const shift=(date:string,days:number)=>{const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)};
export function calendarContext(today:string){
 const day=(new Date(today+'T12:00:00Z').getUTCDay()+6)%7;
 return {today,tomorrow:shift(today,1),dayAfterTomorrow:shift(today,2),thisWeek:Object.fromEntries(weekdays.map((w,i)=>['周'+w,shift(today,i-day)])),nextWeek:Object.fromEntries(weekdays.map((w,i)=>['周'+w,shift(today,i-day+7)])),weekAfterNext:Object.fromEntries(weekdays.map((w,i)=>['周'+w,shift(today,i-day+14)]))};
}
export function relativeDate(text:string,today:string){
 const c=calendarContext(today),match=text.match(/(下下周|下周|本周|这周)([一二三四五六日天])/);
 if(match){const key='周'+(match[2]==='天'?'日':match[2]);return (match[1]==='下周'?c.nextWeek:match[1]==='下下周'?c.weekAfterNext:c.thisWeek)[key]}
 return text.includes('后天')?c.dayAfterTomorrow:text.includes('明天')?c.tomorrow:text.includes('今天')?c.today:null;
}

// A turn may mention two distinct dates, or use one as the old date when
// moving an appointment. Validate the dates the user actually wants to keep.
export function requiredRelativeDates(text:string,today:string){
 const groups:string[][]=[];
 for(const raw of text.split(/[，,、。；;]/)){
  const clause=raw.trim();if(!clause)continue;
  const leadingCorrection=/^(?:不对|算了|不是|还是|改口|更正|应该是|改到|挪到|推到|换到|延期到|提前到)/.test(clause);
  if(leadingCorrection&&groups.length)groups.pop();
  const mentions=[...clause.matchAll(/(?:下下周|下周|本周|这周)[一二三四五六日天]|后天|明天|今天/g)].map(match=>({index:match.index||0,date:relativeDate(match[0],today)!}));
  if(!mentions.length)continue;
  // "Tomorrow or the day after" offers alternatives, not two appointments.
  if(mentions.length>1&&/(?:或者|或是|还是|或)/.test(clause)&&!/(?:改到|挪到|推到|换到|延期到|提前到|改成|推迟到)/.test(clause))continue;
  const moves=[...clause.matchAll(/(?:改到|挪到|推到|换到|延期到|提前到|改成|推迟到)/g)];
  const after=moves.length?mentions.filter(m=>m.index>(moves.at(-1)!.index||0)):[];
  groups.push((after.length?after:mentions).map(m=>m.date));
 }
 return [...new Set(groups.flat())];
}

// Reject a visible calendar label that contradicts the authoritative date.
// This matters for read-only replies: their dates have no operation payload
// for the write validator to inspect.
export function assertRelativeDateClaims(text:string,answer:string,today:string){
 const mentions=new Set(text.match(/(?:下下周|下周|本周|这周)[一二三四五六日天]|后天|明天|今天/g)||[]);
 for(const phrase of mentions){
  const expected=relativeDate(phrase,today)!;
  let offset=0,index:number;
  while((index=answer.indexOf(phrase,offset))!==-1){
   offset=index+phrase.length;
   const tail=answer.slice(offset,offset+35);
   const claim=tail.match(/^(?:\s*[（(：:]\s*|\s*(?:是|为|即|就是)\s*|\s+)((?:\d{4}[-/]\d{1,2}[-/]\d{1,2})|(?:(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]))/);
   if(!claim)continue;
   const raw=claim[1],iso=raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/),chinese=raw.match(/^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})[日号]$/);
   const year=iso?.[1]||chinese?.[1],month=Number(iso?.[2]||chinese?.[2]),day=Number(iso?.[3]||chinese?.[3]);
   if((year&&Number(year)!==Number(expected.slice(0,4)))||month!==Number(expected.slice(5,7))||day!==Number(expected.slice(8,10)))throw new Error(`相对日期换算错误：${phrase}应为${expected}，请依据权威日历重新回答。`);
  }
 }
}
