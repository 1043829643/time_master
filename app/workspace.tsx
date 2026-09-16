'use client';
import {useCallback,useRef,useState} from 'react';
import {useWorkspace} from './use-workspace';
import DraftLibrary from './draft-library';
import BackupRestore from './backup-restore';
import {exportBackup} from '@/lib/backup';
import {Plus,Search,AudioLines,RefreshCw,Download,Leaf,X,AlertCircle,CheckCircle2,SlidersHorizontal,Clock,ChevronDown} from 'lucide-react';
import {localDay,addDays} from '@/lib/domain';
import {beijingNow} from '@/lib/daily-planning';
import {demoOperations} from '@/lib/demo';
import DailyWork,{QuickCapture,DayPlanner} from './daily-work';
import Timeline from './timeline';
import Editor,{type EditItem} from './editor';
import Assistant,{type AssistantEntry} from './assistant';
import CalendarView from './calendar';
import ProjectContext from './project-context';
import FindAnything from './find-anything';
import {useWorkspaceTools} from './webmcp';
import {dayCandidates,taskBlockers} from '@/lib/planning';

export default function Workspace(){
 const {snapshot,loading,loaded,busy,notice,setNotice,notify,receive,reload,save,syncState,lastSynced,dialog}=useWorkspace();
 const [view,setView]=useState<'today'|'projects'>('today'),[agentOpen,setAgentOpen]=useState(false),[editor,setEditor]=useState<EditItem|null>(null),[date,setDate]=useState(localDay()),[projectId,setProjectId]=useState(''),[find,setFind]=useState(false),[planner,setPlanner]=useState(false),[entry,setEntry]=useState<AssistantEntry|null>(null),[accepted,setAccepted]=useState<AssistantEntry|null>(null),[filter,setFilter]=useState('');
 const closeAssistant=useRef<()=>void>(()=>setAgentOpen(false)),data=snapshot.data,today=localDay();
 const closeEditor=useCallback(()=>setEditor(null),[]),acceptEntry=useCallback((e:AssistantEntry)=>{setAccepted(e);setEntry(current=>current?.id===e.id?null:current)},[]);
 const open=(item:EditItem)=>{if(!loaded)return;if(!item.draftKey&&(item.kind==='task'||item.kind==='resource')&&!data.projects.length){notify('先建一个项目来放这些事，零散想法也可以直接记下来。');setEditor({kind:'project'});return}setEditor({...item})};
 useWorkspaceTools(snapshot,open);
 function ask(text=''){setEntry({id:crypto.randomUUID(),text});setAgentOpen(true)}
 function togglePlanner(){if(!planner&&date<=today)setDate(beijingNow().slice(11)>='17:45'?addDays(today,1):today);setPlanner(v=>!v)}
 function backup(){const blob=new Blob([JSON.stringify(exportBackup(data),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='时间管理大师-'+today+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 async function demo(){if(data.projects.length)return;await save(demoOperations(),'载入示例项目，可随时编辑或删除')}
 const shared={snapshot,save,busy,open,receive,notify},ready=dayCandidates(data,date).ready;
 const attention=data.tasks.filter(t=>t.status!=='done'&&(t.deadline&&t.deadline<=addDays(today,1)||taskBlockers(data,t).length));
 return <>{dialog}<div className={'app-shell quiet-shell '+(agentOpen?'with-agent':'')}>
 <div className="main-shell"><header className="quiet-topbar"><a href="#" className="quiet-brand" onClick={e=>{e.preventDefault();setView('today')}}><Leaf size={22}/><span>时间管理大师</span></a>
  <nav className="primary-nav" aria-label="主要入口"><button aria-current={view==='today'?'page':undefined} className={view==='today'?'active':''} onClick={()=>setView('today')}>今天</button><button aria-current={view==='projects'?'page':undefined} className={view==='projects'?'active':''} onClick={()=>setView('projects')}>项目全景</button></nav>
  <div className="quiet-tools"><button className="icon-button" disabled={!loaded} aria-label="找人、文件或事情" title="找人、文件或事情" onClick={()=>setFind(true)}><Search size={19}/></button><button className={'icon-button '+(agentOpen?'selected':'')} aria-label="打开时间伙伴" title="聊一聊，也可以用语音" disabled={!loaded} onClick={()=>agentOpen?closeAssistant.current():ask()}><AudioLines size={20}/></button><details className="utility-menu"><summary aria-label="工作空间工具"><SlidersHorizontal size={18}/></summary><div className="utility-content"><span className="sync-caption">{busy?'正在保存':syncState==='synced'?'已同步 · '+lastSynced:syncState==='offline'?'离线，尚未同步':'正在连接'}</span><button className="text-button" disabled={busy||loading} onClick={reload}><RefreshCw size={15}/>刷新数据</button><button className="text-button" disabled={!loaded} onClick={backup}><Download size={15}/>导出备份</button>{loaded&&<><DraftLibrary open={open}/><BackupRestore receive={receive} notify={notify} disabled={busy}/></>}</div></details></div>
 </header>
 <main className="quiet-main">
 {notice&&<div className={'notice '+(notice.error?'error':'')} role={notice.error?'alert':'status'}>{notice.error?<AlertCircle size={17}/>:<CheckCircle2 size={17}/>}<span>{notice.text}</span><button className="icon-button" onClick={()=>setNotice(null)} aria-label="关闭提示"><X size={15}/></button></div>}
 {!loaded?<div className="loading-state"><Leaf size={30}/><h3>{loading?'正在打开工作空间…':'暂时没有连上'}</h3>{!loading&&<div className="row"><button className="secondary" onClick={reload}>重试</button><a className="text-button" href="/signin-with-chatgpt?return_to=%2F" target="_top">重新登录</a></div>}</div>:view==='today'?<>
  <QuickCapture snapshot={snapshot} save={save} busy={busy} ask={ask} accepted={accepted}/>
  <div className="today-layout"><section className="today-schedule"><div className="compact-section-heading"><h1>时间，留给手上的事。</h1><button className="text-button" aria-expanded={planner} onClick={togglePlanner}><Clock size={16}/>{planner?'收起安排':date<=today&&beijingNow().slice(11)>='17:45'?'安排明天':'帮我挑个安排'}<ChevronDown size={14}/></button></div>
   {planner&&<DayPlanner key={date} {...shared} date={date<today?today:date} onDateChange={setDate}/>}
   {attention.length>0&&<details className="attention-tasks"><summary>{attention.filter(t=>t.deadline&&t.deadline<=addDays(today,1)).length>0?'临近截止，别遗漏':'有些事情还在等条件'} · {attention.length} 件</summary>{attention.map(t=><button key={t.id} onClick={()=>open({kind:'task',id:t.id})}><strong>{t.name}</strong><small>{[t.deadline?'截止 '+t.deadline:'',...taskBlockers(data,t)].filter(Boolean).join(' · ')}</small></button>)}</details>}
   <CalendarView data={data} date={date} setDate={setDate} busy={busy} open={open} save={save} compact/>
   {ready.length>0&&<details className="available-tasks"><summary>有空时，可以推进 <span>{ready.length} 件</span></summary>{ready.map(t=><div key={t.id} className="available-row"><button onClick={()=>open({kind:'task',id:t.id})}><strong>{t.name}</strong><small>{data.projects.find(p=>p.id===t.projectId)?.name}</small></button><button className="text-button" onClick={()=>open({kind:'block',taskId:t.id,date})}>排时间</button></div>)}</details>}
  </section><aside className="today-loose-ends"><DailyWork {...shared} mode="queue"/></aside></div>
 </>:<>
  <div className="panorama-heading"><div><h1>项目全景</h1><p>{data.projects.filter(p=>p.status==='active').length} 个项目在推进 · 点开项目，人、文件和下一步都在一起</p></div><button className="primary" disabled={busy} onClick={()=>open({kind:'project'})}><Plus size={17}/>新项目</button></div>
  {data.projects.length?<><div className="panorama-tools"><label className="search-box"><Search size={16}/><input aria-label="筛选项目与事项" placeholder="找一个项目或事项" value={filter} onChange={e=>setFilter(e.target.value)}/></label></div><Timeline data={data} filter={filter} editTask={t=>open({kind:'task',id:t.id})} editProject={p=>setProjectId(p.id)} addTask={id=>open({kind:'task',projectId:id})}/><div className="project-shortcuts">{data.projects.filter(p=>!filter||p.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())||data.tasks.some(t=>t.projectId===p.id&&t.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))).map(p=><button key={p.id} onClick={()=>setProjectId(p.id)}>{p.name}<span>{data.tasks.filter(t=>t.projectId===p.id&&t.status!=='done').length} 件待推进</span></button>)}</div></>:<div className="quiet-empty project-empty"><h2>手上有什么项目？</h2><p>可以先建一个，也可以直接和时间伙伴聊。</p><div className="row"><button className="primary" onClick={()=>open({kind:'project'})}>创建项目</button><button className="text-button" disabled={busy} onClick={demo}>看看示例</button></div></div>}
 </>}
 </main></div>
 {loaded&&<Assistant visible={agentOpen} entry={entry} onEntryAccepted={acceptEntry} closeRequest={closeAssistant} snapshot={snapshot} receive={receive} save={save} globalBusy={busy} close={()=>setAgentOpen(false)}/>}
 {find&&<FindAnything data={data} close={()=>setFind(false)} open={open} project={setProjectId}/>}
 {projectId&&<ProjectContext {...shared} projectId={projectId} close={()=>setProjectId('')}/>}
 {editor&&<Editor key={editor.draftKey||editor.kind+(editor.id||'new')} item={editor} data={data} busy={busy} close={closeEditor} save={save} receive={receive}/>}
 </div></>;
}
