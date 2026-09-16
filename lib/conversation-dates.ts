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
