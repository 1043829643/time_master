import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {emptyData,validateData} from '../lib/domain.ts';
import {assembleWorkspace,metadata,collections} from '../lib/workspace-storage.ts';
export function database(){
 const sql=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
 const batches=[];
 const db={prepare(query){return {bind(...args){for(const value of args)if(typeof value==='string'&&Buffer.byteLength(value)>2000000)throw new Error('D1 bound value exceeds 2 MB');const stmt=sql.prepare(query);const execute=()=>/^(SELECT|PRAGMA|WITH)\b/i.test(query.trim())?{results:stmt.all(...args),meta:{changes:0}}:{results:[],meta:{changes:Number(stmt.run(...args).changes)}};return {first:async()=>stmt.get(...args)??null,all:async()=>({results:stmt.all(...args)}),run:async()=>execute(),execute}}}},async batch(statements){batches.push(statements.length);sql.exec('BEGIN');try{const result=statements.map(s=>s.execute());sql.exec('COMMIT');return result}catch(e){sql.exec('ROLLBACK');throw e}}};
 sql.prepare('INSERT INTO workspaces(owner,payload,revision,updated_at,storage_version) VALUES (?,?,0,?,1)').run('owner',metadata(emptyData()),new Date().toISOString());
 const snapshot=(owner='owner')=>{const row=sql.prepare('SELECT * FROM workspaces WHERE owner=?').get(owner);return row.storage_version?assembleWorkspace(row.payload,sql.prepare('SELECT kind,id,payload,position FROM workspace_records WHERE owner=? ORDER BY kind,position').all(owner),row.revision):{data:validateData(JSON.parse(row.payload)),revision:row.revision};};
 const update=(data,owner='owner')=>{sql.exec('BEGIN');try{sql.prepare('UPDATE workspaces SET payload=?,revision=revision+1,storage_version=1 WHERE owner=?').run(metadata(data),owner);sql.prepare('DELETE FROM workspace_records WHERE owner=?').run(owner);const insert=sql.prepare('INSERT INTO workspace_records(owner,kind,id,payload,position) VALUES (?,?,?,?,?)');for(const kind of collections)data[kind].forEach((value,position)=>insert.run(owner,kind,'id' in value?value.id:'history-'+position,JSON.stringify(value),position));sql.exec('COMMIT')}catch(e){sql.exec('ROLLBACK');throw e}};
 return {sql,db,snapshot,update,batches};
}
