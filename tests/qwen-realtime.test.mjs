import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_SDP_BYTES,REALTIME_MODEL,REALTIME_OMNI_MODEL,readLimitedSdp,realtimeCredential,realtimeSettings,realtimeSignallingUrl,validateSdp} from '../lib/qwen-realtime.ts';

const offer='v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n';

test('standard realtime requires a standard key and an explicit workspace; subscription path requires an explicit test switch',()=>{
 const token=realtimeSettings({QWEN_ACCESS_MODE:'token-plan',QWEN_API_KEY:'sk-sp-subscription'});
 assert.equal(token.configured,false);
 assert.equal(realtimeCredential({QWEN_ACCESS_MODE:'token-plan',QWEN_API_KEY:'sk-sp-subscription'}),'');
 assert.equal(realtimeSettings({QWEN_ACCESS_MODE:'token-plan',QWEN_REALTIME_API_KEY:'sk-sp-subscription',QWEN_REALTIME_WORKSPACE_ID:'ws-123'}).configured,false);
 const testMode={QWEN_ACCESS_MODE:'token-plan',QWEN_API_KEY:'sk-sp-subscription',QWEN_REALTIME_TEST_MODE:'token-plan'};
 assert.equal(realtimeCredential(testMode),'sk-sp-subscription');
 assert.equal(realtimeSettings(testMode).configured,true);
 assert.equal(realtimeSettings(testMode).workspaceId,'token-plan');
 assert.equal(realtimeSignallingUrl('token-plan',REALTIME_MODEL,true),`https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=${REALTIME_MODEL}`);
 assert.equal(realtimeSettings({...testMode,QWEN_ACCESS_MODE:'standard'}).configured,false);
 assert.equal(realtimeSettings({QWEN_ACCESS_MODE:'token-plan',QWEN_REALTIME_API_KEY:'standard-key',QWEN_REALTIME_WORKSPACE_ID:'ws-123'}).configured,true);
 assert.equal(realtimeSettings({QWEN_ACCESS_MODE:'standard',QWEN_API_KEY:'present'}).configured,false);
 assert.equal(realtimeSettings({QWEN_ACCESS_MODE:'standard',QWEN_REALTIME_WORKSPACE_ID:'ws-123'}).configured,false);
 assert.equal(realtimeSettings({QWEN_ACCESS_MODE:'standard',QWEN_REALTIME_WORKSPACE_ID:'ws-123',QWEN_API_KEY:'present'}).configured,true);
});

test('endpoint construction rejects malformed workspaces and unknown models rather than allowing arbitrary provider hosts',()=>{
 for(const value of ['','token-plan','../../evil','token-plan.evil.test','has space','-bad','bad-','a'.repeat(65)]){
  assert.throws(()=>realtimeSignallingUrl(value));
 }
 assert.equal(realtimeSignallingUrl('ws-123'),`https://ws-123.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=${REALTIME_MODEL}`);
 assert.equal(realtimeSignallingUrl('ws-123',REALTIME_OMNI_MODEL),`https://ws-123.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=${REALTIME_OMNI_MODEL}`);
 assert.throws(()=>realtimeSignallingUrl('ws-123','anything-else'));
 assert.equal(realtimeSettings({QWEN_REALTIME_API_KEY:'present',QWEN_REALTIME_WORKSPACE_ID:'ws-123'}).voice,'longanqian');
 assert.equal(realtimeSettings({QWEN_REALTIME_API_KEY:'present',QWEN_REALTIME_WORKSPACE_ID:'ws-123',QWEN_REALTIME_MODEL:REALTIME_OMNI_MODEL}).voice,'Tina');
});

test('SDP accepts browser-shaped audio offers and rejects empty, oversized, non-audio or binary input',async()=>{
 assert.equal(validateSdp(offer),true);
 assert.equal(await readLimitedSdp(new Request('https://example.test',{method:'POST',body:offer})),offer);
 for(const value of ['',offer.replace('v=0','v=1'),offer.replace('m=audio','m=video'),offer+'\0',offer+'a'.repeat(MAX_SDP_BYTES)])assert.equal(validateSdp(value),false);
 await assert.rejects(readLimitedSdp(new Request('https://example.test',{method:'POST',body:'x'.repeat(MAX_SDP_BYTES+1)})),/过大/);
});
