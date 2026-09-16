'use client';
import {useState} from 'react';
import {X,Plus,Copy,FolderOpen,ArrowUpRight,CalendarPlus} from 'lucide-react';
import {localDay,statusLabels} from '@/lib/domain';
import {taskBlockers} from '@/lib/planning';
import DailyWork,{type DailyWorkProps} from './daily-work';
import RecoveryDialog from './recovery-dialog';

export default function ProjectContext(props:DailyWorkProps&{projectId:string;close:()=>void}){
 const {snapshot:{data},projectId,open,busy,save,notify,close}=props,p=data.projects.find(p=>p.id===projectId),[showDone,setShowDone]=useState(false);
 if(!p)return <RecoveryDialog label="项目已移除" className="project-context-layer" close={close}><h2>这个项目已被移除</h2><button className="secondary" onClick={close}>回到全景</button></RecoveryDialog>;
 const tasks=data.tasks.filter(t=>t.projectId===p.id),visible=tasks.filter(t=>showDone||t.status!=='done'),related=data.followups.filter(f=>f.projectId===p.id||tasks.some(t=>t.id===f.taskId)),people=data.contacts.filter(c=>c.roles.some(r=>r.projectId===p.id)||tasks.some(t=>t.contactId===c.id)||related.some(f=>f.contactId===c.id)||data.blocks.some(b=>b.contactId===c.id&&tasks.some(t=>t.id===b.taskId))),files=data.resources.filter(r=>r.projectId===p.id);
 async function copy(text:string){try{await navigator.clipboard.writeText(text);notify('已复制')}catch{notify('复制失败，请选中文字后复制。',true)}}
 return <RecoveryDialog label={p.name+' · 项目详情'} className="project-context-layer" close={close}>
  <header className="context-heading"><div><span className="muted small">项目详情</span><h2>{p.name}</h2></div><button className="icon-button" aria-label="关闭项目详情" onClick={close}><X size={20}/></button></header>
  {p.goal&&<p className="project-goal">{p.goal}</p>}
  <div className="context-summary"><span>{tasks.filter(t=>t.status==='done').length}/{tasks.length} 已完成 · {p.start.slice(5)}—{p.end.slice(5)}</span><button className="text-button" onClick={()=>open({kind:'project',id:p.id})}>编辑目标与周期</button></div>
  <section className="context-section"><div className="row between"><h3>接着推进</h3><button className="text-button" disabled={busy} onClick={()=>open({kind:'task',projectId:p.id})}><Plus size={15}/>添一件事</button></div>
   {visible.map(t=>{const blockers=taskBlockers(data,t);return <article className="context-task" key={t.id}><div className="context-task-line"><button className="context-task-title" onClick={()=>open({kind:'task',id:t.id})}><strong>{t.name}</strong><span>{t.result||t.description||'补充进展或下一步'}</span></button><select aria-label={'更新'+t.name+'状态'} value={t.status} disabled={busy} onChange={e=>void save([{type:'task.save',data:{id:t.id,status:e.target.value}}],t.name+'：'+statusLabels[e.target.value as keyof typeof statusLabels])}>{Object.entries(statusLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div>
    {blockers.length>0&&<p className="context-blocker">{blockers.join('；')}</p>}<div className="context-task-footer"><small>{t.deadline?'截止 '+t.deadline:'预计 '+t.end} · 还需 {t.remainingHours??t.hours} 小时</small><div className="row"><button className="text-button" onClick={()=>open({kind:'followup',projectId:p.id,taskId:t.id})}>等回复</button><button className="text-button" onClick={()=>open({kind:'block',taskId:t.id,date:localDay()})}><CalendarPlus size={14}/>排时间</button></div></div></article>})}
   {!visible.length&&<p className="quiet-empty">{tasks.length?'当前事项都已完成。':'还没拆出具体事项。可以先聊一聊，或添一件事。'}</p>}
   {tasks.some(t=>t.status==='done')&&<button className="text-button" onClick={()=>setShowDone(v=>!v)}>{showDone?'收起已完成':'查看已完成 · '+tasks.filter(t=>t.status==='done').length}</button>}
  </section>
  <section className="context-section"><div className="row between"><h3>等谁，等什么</h3><button className="text-button" disabled={busy} onClick={()=>open({kind:'followup',projectId:p.id})}><Plus size={15}/>记个跟进</button></div><DailyWork {...props} mode="followups" projectId={p.id}/></section>
  <details className="context-section context-details" open><summary>相关的人 <span>{people.length}</span></summary>{people.map(c=><div className="context-person" key={c.id}><button className="context-task-title" onClick={()=>open({kind:'contact',id:c.id})}><strong>{c.name}</strong><span>{c.roles.filter(r=>r.projectId===p.id).map(r=>r.role).join('、')||'项目中的联系人'}{c.wechat?' · '+c.wechat:''}</span></button><button className="icon-button" disabled={!c.wechat} aria-label={'复制'+c.name+'联系方式'} onClick={()=>copy(c.wechat)}><Copy size={15}/></button></div>)}<button className="text-button" onClick={()=>open({kind:'contact',projectId:p.id})}><Plus size={15}/>记录联系人</button></details>
  <details className="context-section context-details" open><summary>工程与文件 <span>{files.length}</span></summary>{files.map(r=><div className="context-file" key={r.id}><button className="context-task-title" onClick={()=>open({kind:'resource',id:r.id})}><strong><FolderOpen size={16}/>{r.name}<ArrowUpRight size={13}/></strong><span>{r.device||'电脑待补充'}{r.purpose?' · '+r.purpose:''}</span></button><div className="context-path"><code>{r.path}</code><button className="icon-button" aria-label={'复制'+r.name+'路径'} onClick={()=>copy(r.path)}><Copy size={15}/></button></div></div>)}<button className="text-button" onClick={()=>open({kind:'resource',projectId:p.id})}><Plus size={15}/>记录文件位置</button></details>
 </RecoveryDialog>;
}
