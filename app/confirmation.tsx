'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

export function useConfirmation(){
 const [message,setMessage]=useState<string|null>(null),resolve=useRef<((result:boolean)=>void)|null>(null),previous=useRef<HTMLElement|null>(null);
 useEffect(()=>()=>{resolve.current?.(false)},[]);
 function confirm(text:string){resolve.current?.(false);previous.current=document.activeElement as HTMLElement;return new Promise<boolean>(done=>{resolve.current=done;setMessage(text)})}
 function finish(value:boolean){resolve.current?.(value);resolve.current=null;setMessage(null);if(previous.current?.isConnected)previous.current.focus()}
 return {confirm,dialog:message===null?null:createPortal(<Confirmation message={message} finish={finish}/>,document.body)};
}
function Confirmation({message,finish}:{message:string;finish:(value:boolean)=>void}){
 const cancel=useRef<HTMLButtonElement>(null),accept=useRef<HTMLButtonElement>(null),title=useId();
 useEffect(()=>{cancel.current?.focus()},[message]);
 return <div className="confirm-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)finish(false)}} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();finish(false)}if(e.key==='Tab'){e.preventDefault();(document.activeElement===cancel.current?accept:cancel).current?.focus()}}}><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={title} aria-describedby={title+'-message'}><h2 id={title}>再确认一下</h2><p id={title+'-message'}>{message}</p><div className="row"><button ref={cancel} className="secondary" onClick={()=>finish(false)}>返回检查</button><button ref={accept} className="primary" onClick={()=>finish(true)}>确认继续</button></div></section></div>;
}
