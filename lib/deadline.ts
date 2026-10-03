/** Keep the date and precise time of a task's hard deadline in agreement. */
export function pairedDeadline(deadline:string,deadlineAt:string,changed:'date'|'precise'){
 if(changed==='date')return {deadline,deadlineAt:deadline&&deadlineAt?deadline+deadlineAt.slice(10):''};
 return {deadline:deadlineAt?deadlineAt.slice(0,10):deadline,deadlineAt};
}
