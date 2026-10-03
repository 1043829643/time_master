import test from 'node:test';
import assert from 'node:assert/strict';
import {providerFailure} from '../lib/provider-error.ts';

test('Qwen errors preserve safe diagnosis without reflecting upstream prompt content',()=>{
 const result=providerFailure(401,{code:'InvalidApiKey',request_id:'req-123',message:'private conversation text'});
 assert.match(result.message,/鉴权失败/);
 assert.match(result.message,/InvalidApiKey/);
 assert.match(result.message,/req-123/);
 assert.doesNotMatch(result.message,/private conversation/);
 assert.equal(result.apiStatus,424);
 assert.deepEqual(result.details,{providerStatus:401,providerCode:'InvalidApiKey',providerRequestId:'req-123'});
});

test('unsafe provider identifiers are omitted',()=>{
 const result=providerFailure(429,{error:{code:'secret key sk-test'},request_id:'not safe\nvalue'},'header-request');
 assert.match(result.message,/请求频繁/);
 assert.doesNotMatch(result.message,/sk-test/);
 assert.equal(result.details.providerRequestId,'header-request');
 assert.equal(result.details.providerCode,undefined);
 assert.equal(result.apiStatus,424);
});
