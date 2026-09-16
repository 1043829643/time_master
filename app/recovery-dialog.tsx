'use client';
import {useEffect,useRef,type ReactNode} from 'react';
import {createPortal} from 'react-dom';

export default function RecoveryDialog({label,close,busy=false,children,className=''}:{label:string;close:()=>void;busy?:boolean;children:ReactNode;className?:string}){
 const panel=useRef<HTMLElement>(null),closing=useRef(close),locked=useRef(busy);closing.current=close;locked.current=busy;
 useEffect(()=>{const previous=document.activeElement as HTMLElement,overflow=document.body.style.overflow;document.body.style.overflow='hidden';if(!panel.current?.contains(document.activeElement))panel.current?.focus();return()=>{document.body.style.overflow=overflow;if(previous?.isConnected)previous.focus()}},[]);
 return createPortal(<div className={'modal-backdrop '+className} onMouseDown={e=>{if(e.target===e.currentTarget&&!locked.current)closing.current()}} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();if(!locked.current)closing.current()}if(e.key==='Tab'){const items=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),summary,a[href],input:not(:disabled),textarea:not(:disabled)')||[]).filter(el=>el.getClientRects().length);const index=items.indexOf(document.activeElement as HTMLElement);if(!items.length){e.preventDefault();panel.current?.focus()}else if(e.shiftKey&&index<=0){e.preventDefault();items.at(-1)?.focus()}else if(!e.shiftKey&&(index===items.length-1||index<0)){e.preventDefault();items[0].focus()}}}}><section ref={panel} className="recovery-panel" tabIndex={-1} role="dialog" aria-modal="true" aria-label={label}>{children}</section></div>,document.body);
}
