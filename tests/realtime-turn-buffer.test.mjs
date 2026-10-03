import test from 'node:test';
import assert from 'node:assert/strict';
import {RealtimeTurnBuffer} from '../lib/realtime-turn-buffer.ts';

test('partial text and stash are replaced, then only the completed transcript is submitted',()=>{
 const turns=new RealtimeTurnBuffer();
 assert.equal(turns.partial('item-1','','周一两点'),'周一两点');
 assert.equal(turns.partial('item-1','周一','三点'),'周一三点');
 assert.equal(turns.complete('item-1','周一三点'),true);
 assert.equal(turns.flush(),'周一三点');
 assert.equal(turns.complete('item-1','周一三点'),false);
 assert.equal(turns.flush(),'');
});

test('adjacent completed items form one corrected human turn',()=>{
 const turns=new RealtimeTurnBuffer();
 turns.complete('item-1','周一两点安排原型。');
 turns.partial('item-2','不对，','三点');
 assert.equal(turns.preview(),'周一两点安排原型。 不对，三点');
 turns.complete('item-2','不对，三点。');
 assert.equal(turns.flush(),'周一两点安排原型。 不对，三点。');
});

test('failed recognition never becomes an executable turn',()=>{
 const turns=new RealtimeTurnBuffer();
 turns.partial('item-1','','删掉那个项目');
 assert.equal(turns.failed('item-1'),'');
 assert.equal(turns.flush(),'');
});
