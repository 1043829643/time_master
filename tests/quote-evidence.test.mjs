import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyData} from '../lib/domain.ts';
import {originalQuote} from '../lib/quote-evidence.ts';
import {parseConversation} from '../lib/conversation-response.ts';
import {memoryInputSchema,prepareMemories} from '../lib/conversation-memory.ts';

const tool=(args)=>({tool_calls:[{function:{name:'respond_to_user',arguments:JSON.stringify({responses:[],planUpdates:[],memories:[],forgetMemories:[],...args})}}]});
const block={type:'block.save',data:{id:'discussion',name:'讨论',taskId:'',start:'2026-10-09T14:00',end:'2026-10-09T14:30',fixed:false,done:false}};

test('只容忍连续原话中的空白与标点差异，保留原句而不接受改写或重排',()=>{
 assert.equal(originalQuote('嗯，先看😀，再安排讨论。','先看 😀 再安排讨论'),'先看😀，再安排讨论');
 assert.equal(originalQuote('先做甲，再做乙','先做乙，再做甲'),null);
 assert.equal(originalQuote('把事项挪到周一','把事项改到周一'),null);
 assert.equal(originalQuote('明天看','，'),null);
 assert.equal(originalQuote('明天看？','？'),null);
});

test('模型标点差异在执行判断、意图审计和记忆前恢复为真实原话',()=>{
 const text='嗯，平时九点半以后开始；10月9日14:00留一段叫「讨论」的日程，我先看方案。';
 const result=parseConversation(tool({
  execution:{mode:'preview',quote:'我,先看方案'},
  responses:[{quote:'10月9日 14:00，留一段叫讨论的日程',kind:'change',answer:'',operations:[block]}],
  memories:[{kind:'preference',statement:'九点半以后开始',quote:'平时，九点半以后开始',certainty:'confirmed',rule:'not_before',time:'09:30'}],
 }),emptyData(),'quote-preview',text,[],[]);
 assert.equal(result.execution.quote,'我先看方案');
 assert.equal(result.conversation.audit.intents[0].quote,'10月9日14:00留一段叫「讨论」的日程');
 assert.equal(result.conversation.memories[0].quote,'平时九点半以后开始');
 assert.equal(result.draft.operations.length,1);
});

test('方案更新和忘记记忆的引用也用原文，不能靠改写绕过证据检查',()=>{
 const known=prepareMemories([memoryInputSchema.parse({kind:'context',statement:'旧习惯',quote:'旧习惯',certainty:'confirmed'})],[],'旧习惯','known',emptyData());
 const text='先不要旧方案，把刚才那条习惯忘了。';
 const pending=[{id:'old-apply',summary:'讨论',operations:[block],workRevision:0}];
 const result=parseConversation(tool({
  responses:[{quote:'先不要,旧方案',kind:'withdraw',answer:'好的，先不应用。',operations:[]}],
  planUpdates:[{id:'old-apply',action:'dismiss',quote:'先不要,旧方案'}],
  forgetMemories:[{id:known[0].id,quote:'把刚才那条习惯,忘了'}],
 }),emptyData(),'withdraw-and-forget',text,pending,known);
 assert.equal(result.conversation.audit.planUpdates[0].quote,'先不要旧方案');
 assert.equal(result.conversation.transitions[0].reason,'根据你的新决定：先不要旧方案');
 assert.deepEqual(result.conversation.forgotten,[known[0].id]);
 assert.throws(()=>parseConversation(tool({responses:[{quote:'不要旧方案然后创建新项目',kind:'withdraw',answer:'好的'}]}),emptyData(),'bad-evidence',text,pending,known),/逐字引用/);
});

test('单独准备记忆也会规范为用户原话',()=>{
 const [memory]=prepareMemories([memoryInputSchema.parse({kind:'context',statement:'稍后再说',quote:'稍后，再说',certainty:'tentative'})],[],'嗯，稍后再说。','standalone',emptyData());
 assert.equal(memory.quote,'稍后再说');
 assert.equal(memory.statement,'稍后再说');
});
