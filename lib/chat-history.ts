import {type Data} from './domain.ts';
export function mergeMessages(...groups:Data['messages'][]):Data['messages']{
 const map=new Map(groups.flat().map(m=>[m.id,m]));
 return [...map.values()].sort((a,b)=>a.at.localeCompare(b.at)||a.id.slice(0,-2).localeCompare(b.id.slice(0,-2))||(a.role===b.role?0:a.role==='user'?-1:1));
}
