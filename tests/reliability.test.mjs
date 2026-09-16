import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {emptyData,applyOperations,validateData} from '../lib/domain.ts';
import {commitChat,readChatReceipt,savedChat,pendingProposals,commitWorkspace} from '../lib/chat-state.ts';
import {requestJson,ClientError} from '../lib/api-client.ts';
import {captureBaseline,mergeChanges} from '../lib/changes.ts';
import {chatHistory} from '../lib/chat-state.ts';
import {commitRestore,readRestore} from '../lib/restore-state.ts';
import {parseBackup,restorePlan} from '../lib/backup.ts';

function database(){
 const sql=new DatabaseSync(':memory:');
 for(const migration of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync(new URL('../drizzle/'+migration,import.meta.url),'utf8'));
 const db={
  prepare(query){return {bind(...args){const stmt=sql.prepare(query);return {first:async()=>stmt.get(...args)??null,all:async()=>({results:stmt.all(...args)}),execute:()=>({meta:{changes:stmt.run(...args).changes}})}}};},
  async batch(statements){sql.exec('BEGIN');try{const results=statements.map(s=>s.execute());sql.exec('COMMIT');return results}catch(e){sql.exec('ROLLBACK');throw e}}
 };
 sql.prepare('INSERT INTO workspaces VALUES (?,?,0,?)').run('owner',JSON.stringify(emptyData()),new Date().toISOString());
 const snapshot=()=>{const row=sql.prepare('SELECT * FROM workspaces WHERE owner=?').get('owner');return {data:validateData(JSON.parse(row.payload)),revision:row.revision}};
 const update=(data)=>sql.prepare('UPDATE workspaces SET payload=?,revision=revision+1 WHERE owner=?').run(JSON.stringify(data),'owner');
 return {sql,db,snapshot,update};
}

test('大备份原子提交，响应丢失后回执可读，重试不重写且用户隔离',async()=>{
 const {sql,db,snapshot}=database(),source=emptyData();source.blocks=Array.from({length:90},(_,i)=>({id:'b'+i,name:'备份'+i,start:'2026-09-18T10:00',end:'2026-09-18T11:00',taskId:'',done:false,fixed:false}));
 const before=snapshot(),data=restorePlan(before.data,parseBackup({data:source}),'copies','restore-test').data;assert.equal(await commitRestore(db,'owner',before,data,'restore-test','hash'),true);assert.equal(snapshot().data.blocks.length,90);assert.equal(await commitRestore(db,'owner',snapshot(),data,'restore-test','hash'),false);assert.equal(snapshot().revision,1);assert.equal((await readRestore(db,'owner','restore-test')).fingerprint,'hash');assert.equal(await readRestore(db,'other','restore-test'),null);sql.close();
});
test('恢复 CAS 失败不留下回执；聊天更新后重读保留最新消息',async()=>{
 const {sql,db,snapshot}=database(),before=snapshot();await commitChat(db,'owner',before,'fresh-chat','新问题','新回答',null,0);assert.equal(await commitRestore(db,'owner',before,before.data,'restore-race','hash'),false);assert.equal(await readRestore(db,'owner','restore-race'),null);
 const latest=snapshot(),source=parseBackup({data:applyOperations(emptyData(),[{type:'block.save',data:{id:'b',name:'恢复日程',start:'2026-09-18T10:00',end:'2026-09-18T11:00'}}],'seed')});const data=restorePlan(latest.data,source,'missing','restore-race').data;assert.equal(await commitRestore(db,'owner',latest,data,'restore-race','hash'),true);assert.equal(snapshot().data.messages.length,2);assert.equal(snapshot().data.blocks.length,1);sql.close();
});
test('恢复事务后半段失败会回滚所有记录及回执',async()=>{
 const {sql,db,snapshot}=database();sql.exec("CREATE TRIGGER fail_restore BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT,'simulated restore'); END");await assert.rejects(commitRestore(db,'owner',snapshot(),emptyData(),'rollback-restore','hash'),/simulated restore/);assert.equal(await readRestore(db,'owner','rollback-restore'),null);assert.equal(snapshot().revision,0);sql.close();
});
test('同一毫秒85轮聊天跨三页无遗漏，所有方案状态可读且用户隔离',async()=>{
 const {sql,db}=database(),insert=sql.prepare('INSERT INTO chat_receipts(owner,request_id,request_text,reply,proposal,work_revision,commit_token,created_at,proposal_state) VALUES (?,?,?,?,NULL,0,?,?,?)');
 for(let i=0;i<85;i++)insert.run('owner','history-'+String(i).padStart(3,'0'),'问题'+i,'回答'+i,'token'+i,'2026-09-16T00:00:00.000Z',['pending','applied','dismissed'][i%3]);
 const a=await chatHistory(db,'owner'),b=await chatHistory(db,'owner',a.nextCursor),c=await chatHistory(db,'owner',b.nextCursor),messages=[...a.messages,...b.messages,...c.messages];assert.deepEqual([a.messages.length,b.messages.length,c.messages.length],[80,80,10]);assert.equal(c.nextCursor,null);assert.equal(new Set(messages.map(m=>m.id)).size,170);for(let i=0;i<messages.length;i+=2){assert.equal(messages[i].role,'user');assert.equal(messages[i+1].role,'assistant');}assert.equal((await chatHistory(db,'other')).messages.length,0);sql.close();
});
test('待确认第一页也能检测第21份的冲突，放弃后重新读取立即消失',async()=>{
 const {sql,db,snapshot}=database();for(let i=0;i<21;i++){const id='cross-page-'+String(i).padStart(2,'0'),p={summary:'方案'+i,operations:[{type:'block.save',data:{id,name:id,start:i===0||i===20?'2026-09-18T10:00':'2026-10-'+String(i).padStart(2,'0')+'T10:00',end:i===0||i===20?'2026-09-18T11:00':'2026-10-'+String(i).padStart(2,'0')+'T11:00'}}]};await commitChat(db,'owner',snapshot(),id,'安排','方案',p,0,captureBaseline(snapshot().data,p.operations));}
 sql.exec("UPDATE chat_receipts SET created_at='2026-09-16T00:00:00.000Z'");let page=await pendingProposals(db,'owner',snapshot());assert.equal(page.drafts.length,20);assert.ok(page.drafts.find(d=>d.id==='cross-page-20-apply').pendingWarnings.length);sql.exec("UPDATE chat_receipts SET proposal_state='dismissed' WHERE request_id='cross-page-00'");page=await pendingProposals(db,'owner',snapshot());assert.deepEqual(page.drafts.find(d=>d.id==='cross-page-20-apply').pendingWarnings,[]);sql.close();
});
test('新版方案保留原始基线，两份独立方案连续应用与刷新恢复',async()=>{
 const {sql,db,snapshot}=database();const one={summary:'甲',operations:[{type:'block.save',data:{id:'one',name:'甲',start:'2026-09-18T10:00',end:'2026-09-18T11:00'}}]},two={summary:'乙',operations:[{type:'block.save',data:{id:'two',name:'乙',start:'2026-09-19T10:00',end:'2026-09-19T11:00'}}]};const original=snapshot();
 await commitChat(db,'owner',snapshot(),'record-one','甲','方案',one,0,captureBaseline(original.data,one.operations));await commitChat(db,'owner',snapshot(),'record-two','乙','方案',two,0,captureBaseline(original.data,two.operations));
 let current=snapshot();await commitWorkspace(db,'owner',current,applyOperations(current.data,one.operations,'record-one-apply'),'record-one-apply');
 const saved=savedChat(snapshot(),'record-two','乙',await readChatReceipt(db,'owner','record-two'));assert.equal(saved.draft.blocked,undefined);const ops=mergeChanges(snapshot().data,saved.draft.operations,saved.draft.baseline);current=snapshot();await commitWorkspace(db,'owner',current,applyOperations(current.data,ops,'record-two-apply'),'record-two-apply');assert.equal(snapshot().data.blocks.length,2);assert.equal((await pendingProposals(db,'owner',snapshot())).drafts.length,0);sql.close();
});
test('不存在的方案回执不能执行提交，跨用户回执不能代替当前用户',async()=>{
 const {sql,db,snapshot}=database();const current=snapshot(),data=applyOperations(current.data,[{type:'block.save',data:{id:'x',name:'x',start:'2026-09-18T10:00',end:'2026-09-18T11:00'}}],'missing-apply');assert.equal(await commitWorkspace(db,'owner',current,data,'missing-apply'),false);assert.equal(snapshot().data.blocks.length,0);sql.close();
});
test('客户端保留字段冲突详情供表单选择恢复',async(t)=>{
 const details={code:'FIELD_CONFLICT',conflicts:[{field:'result',current:'甲',proposed:'乙'}]};t.mock.method(globalThis,'fetch',async()=>Response.json({error:'请核对',details},{status:409}));await assert.rejects(requestJson('/api/workspace',{}),e=>e instanceof ClientError&&e.details.code==='FIELD_CONFLICT'&&e.details.conflicts[0].current==='甲');
});
const proposal={summary:'新增测试日程',operations:[{type:'block.save',data:{id:'test-block',name:'测试日程',start:'2026-09-16T10:00',end:'2026-09-16T11:00'}}]};

test('聊天不改变业务版本或推进记录，旧数据兼容默认版本',()=>{
 const old=emptyData();delete old.workRevision;assert.equal(validateData(old).workRevision,0);
 const business=applyOperations(emptyData(),proposal.operations,'business');
 const next=applyOperations(business,[{type:'message.add',data:{id:'m',role:'user',content:'你好',at:'now'}}],'chat');
 assert.equal(next.workRevision,business.workRevision);assert.deepEqual(next.blocks,business.blocks);assert.deepEqual(next.history,business.history);
});
test('回复和回执原子保存；丢失响应后取得原方案，不重复追加',async()=>{
 const {sql,db,snapshot}=database();const initial=snapshot();
 const result=await commitChat(db,'owner',initial,'request-1','安排测试','原回复',proposal,0);
 assert.equal(result.revision,1);assert.equal(result.data.messages.length,2);
 assert.equal(await commitChat(db,'owner',initial,'request-1','安排测试','另一回复',null,0),null);
 assert.equal(await commitChat(db,'owner',snapshot(),'request-1','安排测试','另一回复',null,0),null);
 const replay=savedChat(snapshot(),'request-1','安排测试',await readChatReceipt(db,'owner','request-1'));
 assert.equal(replay.reply,'原回复');assert.deepEqual(replay.draft.operations,proposal.operations);assert.equal(snapshot().data.messages.length,2);assert.equal(snapshot().revision,1);sql.close();
});
test('真正的业务更新会使旧方案过期，聊天更新不会',async()=>{
 const {sql,db,snapshot,update}=database();await commitChat(db,'owner',snapshot(),'request-2','安排','方案',proposal,0);
 await commitChat(db,'owner',snapshot(),'request-3','闲聊','你好',null,0);
 const receipt=await readChatReceipt(db,'owner','request-2');assert.equal(savedChat(snapshot(),'request-2','安排',receipt).notice,undefined);
 update(applyOperations(snapshot().data,[{type:'project.save',data:{id:'p',name:'新项目',start:'2026-09-15',end:'2026-09-17'}}],'changed'));
 const replay=savedChat(snapshot(),'request-2','安排',receipt);assert.equal(replay.draft.workRevision,0);assert.equal(replay.snapshot.data.workRevision,1);assert.match(replay.notice,/旧方案未应用/);sql.close();
});
test('业务 CAS 抢先成功时不留孤立回执，重读后仍保存原生成版本',async()=>{
 const {sql,db,snapshot,update}=database();const stale=snapshot();update(applyOperations(stale.data,proposal.operations,'edit'));
 assert.equal(await commitChat(db,'owner',stale,'request-4','安排','方案',proposal,0),null);assert.equal(await readChatReceipt(db,'owner','request-4'),null);
 const result=await commitChat(db,'owner',snapshot(),'request-4','安排','方案',proposal,0);assert.equal(result.data.blocks.length,1);
 assert.equal((await readChatReceipt(db,'owner','request-4')).work_revision,0);sql.close();
});
test('不同聊天并发重试不丢消息，相同编号不能换文字或跨用户读取',async()=>{
 const {sql,db,snapshot}=database();const initial=snapshot();
 const results=await Promise.all([commitChat(db,'owner',initial,'chat-a123','一','答一',null,0),commitChat(db,'owner',initial,'chat-b123','二','答二',null,0)]);
 const loser=results[0]===null?['chat-a123','一','答一']:['chat-b123','二','答二'];
 if(results.some(r=>r===null))await commitChat(db,'owner',snapshot(),...loser,null,0);
 assert.equal(snapshot().data.messages.length,4);const receipt=await readChatReceipt(db,'owner','chat-a123');assert.throws(()=>savedChat(snapshot(),'chat-a123','不同文字',receipt),/内容已改变/);assert.equal(await readChatReceipt(db,'other-owner','chat-a123'),null);sql.close();
});
test('回执独立保留，聊天显示记录裁剪后仍可恢复原回复',async()=>{
 const {sql,db,snapshot,update}=database();await commitChat(db,'owner',snapshot(),'request-5','原问题','原回复',null,0);
 const trimmed=snapshot().data;trimmed.messages=[];trimmed.appliedIds=[];update(trimmed);
 assert.equal(savedChat(snapshot(),'request-5','原问题',await readChatReceipt(db,'owner','request-5')).reply,'原回复');sql.close();
});
test('事务第二条 SQL 失败时第一条回执回滚',async()=>{
 const {sql,db,snapshot}=database();sql.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON workspaces BEGIN SELECT RAISE(ABORT,'simulated'); END");
 await assert.rejects(commitChat(db,'owner',snapshot(),'request-6','问题','回复',null,0),/simulated/);assert.equal(await readChatReceipt(db,'owner','request-6'),null);assert.equal(snapshot().revision,0);sql.close();
});
test('网络重试复用完全相同的请求，已提交但响应丢失只取回回执',async(t)=>{
 let calls=0,saves=0;const receipts=new Map();const bodies=[];
 t.mock.method(globalThis,'fetch',async(_url,init)=>{calls++;bodies.push(init.body);const body=JSON.parse(init.body);if(!receipts.has(body.requestId)){saves++;receipts.set(body.requestId,{reply:'同一回复'});throw new TypeError('Failed to fetch')}return Response.json(receipts.get(body.requestId))});
 assert.deepEqual(await requestJson('/api/qwen/chat',{text:'测试',requestId:'stable-id'}),{reply:'同一回复'});assert.equal(calls,2);assert.equal(saves,1);assert.equal(bodies[0],bodies[1]);
});
test('持续网络错误给出中文；401、409 和 HTML 登录页不盲目重试',async(t)=>{
 let calls=0;const mock=t.mock.method(globalThis,'fetch',async()=>{calls++;throw new TypeError('Failed to fetch')});
 await assert.rejects(requestJson('/api/test',undefined,{retries:0}),e=>e instanceof ClientError&&!/Failed to fetch/.test(e.message));
 for(const status of [401,409]){calls=0;mock.mock.mockImplementation(async()=>{calls++;return Response.json({error:'冲突'},{status})});await assert.rejects(requestJson('/api/test'),e=>e.status===status);assert.equal(calls,1)}
 calls=0;mock.mock.mockImplementation(async()=>{calls++;return new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}})});await assert.rejects(requestJson('/api/test'),e=>e.status===401);assert.equal(calls,1);
});
test('显式取消请求时不重试',async(t)=>{
 let calls=0;t.mock.method(globalThis,'fetch',async(_url,init)=>{calls++;return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}))});
 const controller=new AbortController();const pending=requestJson('/api/test',undefined,{signal:controller.signal});controller.abort();await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(calls,1);
});


test('方案跨刷新/闲聊恢复，放弃后不可恢复且用户隔离',async()=>{
 const {sql,db,snapshot}=database();await commitChat(db,'owner',snapshot(),'persist-1','请安排','方案',proposal,0);
 await commitChat(db,'owner',snapshot(),'persist-2','谢谢','不客气',null,0);
 assert.equal((await pendingProposals(db,'owner',snapshot())).drafts.length,1);
 assert.equal((await pendingProposals(db,'other',snapshot())).drafts.length,0);
 sql.prepare("UPDATE chat_receipts SET proposal_state='dismissed' WHERE request_id=?").run('persist-1');
 assert.equal((await pendingProposals(db,'owner',snapshot())).drafts.length,0);
 assert.equal(savedChat(snapshot(),'persist-1','请安排',await readChatReceipt(db,'owner','persist-1')).draft,null);sql.close();
});
test('方案应用与状态原子保存，裁剪幂等列表后仍不复活',async()=>{
 const {sql,db,snapshot,update}=database();await commitChat(db,'owner',snapshot(),'persist-3','安排','方案',proposal,0);
 const current=snapshot(),next=applyOperations(current.data,proposal.operations,'persist-3-apply');
 assert.equal(await commitWorkspace(db,'owner',current,next,'persist-3-apply'),true);
 const trimmed=snapshot().data;trimmed.appliedIds=[];update(trimmed);
 assert.equal((await readChatReceipt(db,'owner','persist-3')).proposal_state,'applied');
 assert.equal((await pendingProposals(db,'owner',snapshot())).drafts.length,0);sql.close();
});
test('放弃与应用竞争、CAS失败都不会提交错误的方案状态',async()=>{
 const {sql,db,snapshot,update}=database();await commitChat(db,'owner',snapshot(),'persist-4','安排','方案',proposal,0);
 const old=snapshot(),next=applyOperations(old.data,proposal.operations,'persist-4-apply');
 update(old.data);assert.equal(await commitWorkspace(db,'owner',old,next,'persist-4-apply'),false);
 assert.equal((await readChatReceipt(db,'owner','persist-4')).proposal_state,'pending');
 sql.prepare("UPDATE chat_receipts SET proposal_state='dismissed' WHERE request_id=?").run('persist-4');
 assert.equal(await commitWorkspace(db,'owner',snapshot(),next,'persist-4-apply'),false);assert.equal(snapshot().data.blocks.length,0);sql.close();
});
test('方案历史超过20件可继续翻页且保留旧业务版本',async()=>{
 const {sql,db,snapshot}=database();for(let i=0;i<23;i++)await commitChat(db,'owner',snapshot(),'page-'+i,'安排','方案',proposal,0);
 const one=await pendingProposals(db,'owner',snapshot()),two=await pendingProposals(db,'owner',snapshot(),one.nextCursor);
 assert.equal(one.drafts.length,20);assert.equal(two.drafts.length,3);assert.equal(new Set([...one.drafts,...two.drafts].map(d=>d.id)).size,23);assert.equal(two.nextCursor,null);sql.close();
});
