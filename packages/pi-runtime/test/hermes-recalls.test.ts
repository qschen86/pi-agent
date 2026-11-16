import {createRequire} from 'node:module';
import {it,expect} from 'vitest';
import {installHermesProvenance} from '../src/hermes-provenance.js';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
it('persists only successful returned search rows, with event-time content and model',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE memories(id INTEGER PRIMARY KEY,project TEXT,target TEXT,category TEXT,content TEXT,failure_reason TEXT,tool_state TEXT,corrected_to TEXT,created TEXT); INSERT INTO memories VALUES(1,NULL,'memory',NULL,'original',NULL,NULL,NULL,'today')`);
 class Manager {getDb(){return db;}}
 const tools:Record<string,any>={};
 const api=installHermesProvenance(Manager,{on(){},registerTool:(t:any)=>tools[t.name]=t},{platformSessionId:'rt-a',turnId:'turn-a'});
 const manager=new Manager();
 const ctx={model:{provider:'test',id:'model-a'},sessionManager:{getSessionId:()=> 'native-a'}};
 api.registerTool({name:'memory_search',execute:async(_id:any,p:any)=>{
  const rows=manager.getDb().prepare('SELECT * FROM memories').all();
  if(p.fail)throw Error('failed');
  return {details:{success:true,count:p.empty?0:rows.length},content:[]};
 }});
 await tools.memory_search.execute('1',{query:'部署',project:'alpha',category:'convention',limit:5},undefined,undefined,ctx);
 await tools.memory_search.execute('2',{empty:true},undefined,undefined,ctx);
 await expect(tools.memory_search.execute('3',{fail:true},undefined,undefined,ctx)).rejects.toThrow('failed');
 const controller=new AbortController();controller.abort();
 await tools.memory_search.execute('4',{},controller.signal,undefined,ctx);
 manager.getDb().exec("UPDATE memories SET content='changed'");
 const events=db.prepare('SELECT * FROM runtime_memory_recalls').all() as any[];
 expect(events).toHaveLength(1);
 expect(JSON.parse(events[0].entry)).toMatchObject({id:'1',content:'original'});
 expect(JSON.parse(events[0].origin)).toMatchObject({platformSessionId:'rt-a',nativeSessionId:'native-a',model:'model-a',trigger:'memory-tool',tool:'memory_search',query:'部署',queryMethod:'fts5',filters:{project:'alpha',category:'convention',limit:5}});
 db.close();
});
it('captures the actual literal fallback and separates concurrent query contexts',async()=>{
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE memories(id INTEGER PRIMARY KEY,project TEXT,target TEXT,category TEXT,content TEXT,failure_reason TEXT,tool_state TEXT,corrected_to TEXT,created TEXT);INSERT INTO memories VALUES(1,NULL,'memory',NULL,'部署规则',NULL,NULL,NULL,'today')");
 class Manager {getDb(){return db;}}const tools:Record<string,any>={};
 const api=installHermesProvenance(Manager,{on(){},registerTool:(tool:any)=>tools[tool.name]=tool},{platformSessionId:'test'});const manager=new Manager();
 api.registerTool({name:'memory_search',execute:async(_id:any,p:any)=>{await new Promise(r=>setTimeout(r,p.delay));const rows=manager.getDb().prepare('SELECT * FROM memories WHERE content LIKE ?').all('%'+p.query+'%');return {details:{success:true,count:rows.length}};}});
 try{await Promise.all(['部署','规则'].map((query,i)=>tools.memory_search.execute(String(i),{query,delay:5-i},undefined,undefined,{})));
 const origins=db.prepare('SELECT origin FROM runtime_memory_recalls').all().map(r=>JSON.parse(String(r.origin)));
 expect(origins).toHaveLength(2);expect(origins).toEqual(expect.arrayContaining([expect.objectContaining({query:'部署',queryMethod:'literal',effectiveQuery:'%部署%'}),expect.objectContaining({query:'规则',queryMethod:'literal',effectiveQuery:'%规则%'})]));
 }finally{db.close();}
});
