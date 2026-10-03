import test from 'node:test';
import assert from 'node:assert/strict';
import {pairedDeadline} from '../lib/deadline.ts';
import {applyOperations,addDays,emptyData,localDay} from '../lib/domain.ts';
import {makeDayPlan} from '../lib/daily-planning.ts';

test('修改截止日期时保留精确时刻，清空日期时一起清除时刻',()=>{
 assert.deepEqual(pairedDeadline('2026-10-05','2026-10-04T11:30','date'),{deadline:'2026-10-05',deadlineAt:'2026-10-05T11:30'});
 assert.deepEqual(pairedDeadline('','2026-10-04T11:30','date'),{deadline:'',deadlineAt:''});
 assert.deepEqual(pairedDeadline('2026-10-04','2026-10-05T14:00','precise'),{deadline:'2026-10-05',deadlineAt:'2026-10-05T14:00'});
 assert.deepEqual(pairedDeadline('2026-10-05','','precise'),{deadline:'2026-10-05',deadlineAt:''});
});

test('只有精确截止时刻的事项也按硬截止优先排程并显示时刻',()=>{
 const date=addDays(localDay(),1);
 const data=applyOperations(emptyData(),[
  {type:'project.save',data:{id:'p',name:'项目',start:date,end:date}},
  {type:'task.save',data:{id:'ordinary',projectId:'p',name:'一般事项',start:date,end:date,hours:2,priority:'high'}},
  {type:'task.save',data:{id:'precise',projectId:'p',name:'限时提交',start:date,end:date,hours:1,deadlineAt:date+'T10:00'}},
 ],'seed');
 const plan=makeDayPlan(data,{date,start:'09:00',end:'11:00',minutes:60,energy:'focus'},[],'precise-plan',localDay()+'T08:00');
 assert.equal(plan.items[0].taskId,'precise');
 assert.match(plan.items[0].reason,new RegExp('硬截止 '+date+' 10:00'));
 assert.equal(plan.items[0].end,date+'T10:00');
});
