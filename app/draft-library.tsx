'use client';
import RecoveryDialog from './recovery-dialog';
import {useEffect,useState} from 'react';
import {X,FilePenLine} from 'lucide-react';
import {listDrafts} from '@/lib/editor-draft';
import {type EditItem} from './editor';
const labels={project:'项目',task:'事项',block:'日程',contact:'联系人',resource:'工程位置',capture:'随手记',followup:'跟进'};
export default function DraftLibrary({open,scope}:{scope:string;open:(item:EditItem)=>void}){
 const [items,setItems]=useState<ReturnType<typeof listDrafts>>([]),[visible,setVisible]=useState(false);
 useEffect(()=>{const refresh=()=>setItems(listDrafts(scope));refresh();window.addEventListener('time-master-drafts-changed',refresh);return()=>window.removeEventListener('time-master-drafts-changed',refresh)},[scope]);
 return <><button className="text-button" onClick={()=>setVisible(true)}><FilePenLine size={15}/>未保存草稿{items.length?' · '+items.length:''}</button>{visible&&<RecoveryDialog label="未保存草稿" close={()=>setVisible(false)}><div className="row between"><h2>未保存草稿</h2><button className="icon-button" aria-label="关闭草稿列表" onClick={()=>setVisible(false)}><X/></button></div><p>保存在当前标签页。原记录已删除时，可以打开草稿并另存为新记录。</p>{items.map(({key,draft})=><button className="draft-list-item" key={key} onClick={()=>{setVisible(false);open({kind:draft.kind,id:draft.record?draft.id:undefined,draftKey:key})}}><strong>{draft.entries.find(([k])=>k==='name')?.[1]||'未命名'+labels[draft.kind]}</strong><span>{labels[draft.kind]} · 继续编辑</span></button>)}{!items.length&&<p>暂时没有未保存的草稿。</p>}</RecoveryDialog>}</>;
}
