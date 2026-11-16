import {createRequire} from 'node:module';
import {describe,it,expect} from 'vitest';
import {installHermesProvenance} from '../src/hermes-provenance.js';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
describe('Hermes write provenance',()=>{
 it('atomically traces cross-session add/replace/delete, actual maintenance models, and leaves legacy rows unchanged',async()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE memories(id INTEGER PRIMARY KEY,project TEXT,target TEXT,category TEXT,content TEXT,failure_reason TEXT,tool_state TEXT,corrected_to TEXT,created TEXT); INSERT INTO memories VALUES(1,NULL,'memory',NULL,'legacy',NULL,NULL,NULL,'2026-10-19')`);
  class Manager {getDb(){return db;}}
  const hooks:Record<string,Function[]>={},tools:Record<string,any>={};
  const pi:any={on:(event:string,fn:Function)=>(hooks[event]??=[]).push(fn),registerTool:(tool:any)=>tools[tool.name]=tool};
  const api=installHermesProvenance(Manager,pi,{platformSessionId:'rt-one',turnId:'turn-one'});
  const manager=new Manager();
  const ctx:any={model:{provider:'test',id:'model-a'},sessionManager:{getSessionId:()=> 'native-one'},modelRegistry:{getApiKeyAndHeaders:async()=>({ok:true})}};
  api.registerTool({name:'memory_add',execute:async()=>manager.getDb().exec(`INSERT INTO memories VALUES(2,'alpha','memory',NULL,'first',NULL,NULL,NULL,'2026-10-24')`)});
  await tools.memory_add.execute('call',{},undefined,undefined,ctx);
  api.on('session_shutdown',async(_e:any,c:any)=>{
   await c.modelRegistry.getApiKeyAndHeaders({provider:'fallback',id:'model-b'});
   manager.getDb().exec(`UPDATE memories SET content='second' WHERE id=2`);
  });
  await hooks.session_shutdown[0]({},ctx);
  const api2=installHermesProvenance(Manager,pi,{platformSessionId:'rt-two',turnId:'turn-two'});
  api2.registerTool({name:'memory_remove',execute:async()=>manager.getDb().exec('DELETE FROM memories WHERE id=2')});
  await tools.memory_remove.execute('call',{},undefined,undefined,{...ctx,model:{provider:'test',id:'model-c'},sessionManager:{getSessionId:()=> 'native-two'}});
  const rows=db.prepare('SELECT * FROM runtime_memory_writes ORDER BY seq').all() as any[];
  expect(rows).toHaveLength(3);
  expect(rows.map(r=>r.kind)).toEqual(['add','update','delete']);
  expect(rows.map(r=>JSON.parse(r.origin))).toMatchObject([
   {platformSessionId:'rt-one',nativeSessionId:'native-one',turnId:'turn-one',model:'model-a',trigger:'memory-tool'},
   {platformSessionId:'rt-one',model:'model-b',provider:'fallback',trigger:'shutdown-flush'},
   {platformSessionId:'rt-two',nativeSessionId:'native-two',model:'model-c',trigger:'memory-tool'}]);
  expect(JSON.parse(rows[1].before_entry).content).toBe('first');expect(JSON.parse(rows[2].before_entry).content).toBe('second');
  expect(db.prepare('SELECT content,created FROM memories WHERE id=1').get()).toMatchObject({content:'legacy',created:'2026-10-19'});
  expect(rows.some(r=>r.memory_id==='1')).toBe(false);
  expect(()=>db.exec("BEGIN; INSERT INTO memories(id,target,content,created) VALUES(3,'memory','rollback','today'); ROLLBACK")).not.toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM runtime_memory_writes').get()!.n).toBe(3);
  db.close();
 });
});
it('distinguishes pinned Hermes review and correction registration sites from generic turn-end hooks',async()=>{
 const {runInNewContext}=await import('node:vm');
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE memories(id INTEGER PRIMARY KEY,project TEXT,target TEXT,category TEXT,content TEXT,failure_reason TEXT,tool_state TEXT,corrected_to TEXT,created TEXT)');
 class Manager {getDb(){return db;}}
 const hooks:Function[]=[];
 const api=installHermesProvenance(Manager,{on:(_event:string,fn:Function)=>hooks.push(fn),registerTool(){}},{platformSessionId:'test'});
 const manager=new Manager();const write=()=>manager.getDb().exec("INSERT INTO memories(target,content,created) VALUES('memory','fact','today')");
 for(const name of ['background-review','correction-detector','other'])runInNewContext("api.on('turn_end',write)",{api,write},{filename:`/trusted/pi-hermes-memory/src/handlers/${name}.ts`});
 try{for(const hook of hooks)await hook({},{});
 expect(db.prepare('SELECT json_extract(origin,\'$.trigger\') AS trigger FROM runtime_memory_writes ORDER BY seq').all().map(r=>r.trigger)).toEqual(['background-review','correction-save','turn-end-maintenance']);
 }finally{db.close();}
});
it('links actual SQLite mutations to the prepared fact commit context',async()=>{const {withHermesFactCommit}=await import('../src/hermes-provenance.js');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE memories(id INTEGER PRIMARY KEY,project TEXT,target TEXT,category TEXT,content TEXT,failure_reason TEXT,tool_state TEXT,corrected_to TEXT,created TEXT)');class Manager{getDb(){return db;}}installHermesProvenance(Manager,{on(){},registerTool(){}},{});try{await withHermesFactCommit('commit-fixture',async()=>{new Manager().getDb().exec("INSERT INTO memories(target,content,created) VALUES('memory','fact','today')");});expect(JSON.parse(String(db.prepare('SELECT origin FROM runtime_memory_writes').get()?.origin)).factCommitId).toBe('commit-fixture');}finally{db.close();}});
