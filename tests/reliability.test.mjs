import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {emptyData,applyOperations,validateData} from '../lib/domain.ts';
import {commitChat,readChatReceipt,savedChat} from '../lib/chat-state.ts';
import {requestJson,ClientError} from '../lib/api-client.ts';

function database(){
 const sql=new DatabaseSync(':memory:');
 for(const migration of ['0000_daily_patch.sql','0001_oval_trauma.sql'])sql.exec(readFileSync(new URL('../drizzle/'+migration,import.meta.url),'utf8'));
 const db={
  prepare(query){return {bind(...args){const stmt=sql.prepare(query);return {first:async()=>stmt.get(...args)??null,execute:()=>({meta:{changes:stmt.run(...args).changes}})}}};},
  async batch(statements){sql.exec('BEGIN');try{const results=statements.map(s=>s.execute());sql.exec('COMMIT');return results}catch(e){sql.exec('ROLLBACK');throw e}}
 };
 sql.prepare('INSERT INTO workspaces VALUES (?,?,0,?)').run('owner',JSON.stringify(emptyData()),new Date().toISOString());
 const snapshot=()=>{const row=sql.prepare('SELECT * FROM workspaces WHERE owner=?').get('owner');return {data:validateData(JSON.parse(row.payload)),revision:row.revision}};
 const update=(data)=>sql.prepare('UPDATE workspaces SET payload=?,revision=revision+1 WHERE owner=?').run(JSON.stringify(data),'owner');
 return {sql,db,snapshot,update};
}
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
