import {type Data,type Followup} from './domain.ts';
const escape=(s:string)=>s.replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
const utc=(s:string)=>new Date(s+'+08:00').toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
function fold(s:string){let lines:string[]=[],line='';for(const c of s){if(new TextEncoder().encode(line+c).length>74){lines.push(line);line=' '+c}else line+=c}lines.push(line);return lines.join('\r\n');}
export function followupCalendar(data:Data,followups:Followup[]){
 const now=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Time Master//Followups//ZH','CALSCALE:GREGORIAN'];
 for(const f of followups.filter(f=>f.status==='waiting')){const contact=data.contacts.find(c=>c.id===f.contactId),end=new Date(Date.parse(f.dueAt+'+08:00')+15*60000).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');lines.push('BEGIN:VEVENT','UID:'+escape(f.id)+'@time-master','DTSTAMP:'+now,'DTSTART:'+utc(f.dueAt),'DTEND:'+end,'SUMMARY:'+escape('跟进：'+f.name),'DESCRIPTION:'+escape([f.notes,contact?contact.name+' '+contact.wechat:'','从时间管理大师导出；网站变更后请重新导出并核对系统日历。'].filter(Boolean).join('\n')),'BEGIN:VALARM','TRIGGER:-PT10M','ACTION:DISPLAY','DESCRIPTION:'+escape(f.name),'END:VALARM','END:VEVENT');}
 lines.push('END:VCALENDAR');return lines.map(fold).join('\r\n')+'\r\n';
}
