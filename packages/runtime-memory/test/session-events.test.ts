import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it,expect} from 'vitest';
import {HermesMemoryAdapter} from '../src/index.js';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
it('reads only the selected session events, newest first, after memory deletion',()=>{
 const dir=mkdtempSync(join(tmpdir(),'session-memory-')),path=join(dir,'memory.db');
 try{
 const db=new DatabaseSync(path);
 db.exec('CREATE TABLE runtime_memory_writes(event_id TEXT,kind TEXT,origin TEXT,after_entry TEXT,before_entry TEXT); CREATE TABLE runtime_memory_recalls(event_id TEXT,origin TEXT,entry TEXT)');
 const entry=JSON.stringify({id:'1',project:null,target:'memory',category:null,content:'saved',failure_reason:null,tool_state:null,corrected_to:null,created:'today'});
 const origin=(id:string,time:string)=>JSON.stringify({platformSessionId:id,nativeSessionId:'native',turnId:'turn',provider:'p',model:'m',trigger:'memory-tool',writtenAt:time});
 db.prepare('INSERT INTO runtime_memory_writes(event_id,kind,origin,after_entry) VALUES(?,?,?,?)').run('a'.repeat(32),'add',origin('rt-a','2026-10-24T00:00:00Z'),entry);
 db.prepare('INSERT INTO runtime_memory_writes(event_id,kind,origin,after_entry) VALUES(?,?,?,?)').run('b'.repeat(32),'add',origin('rt-other','2026-10-24T01:00:00Z'),entry);
 db.prepare('INSERT INTO runtime_memory_recalls VALUES(?,?,?)').run('c'.repeat(32),origin('rt-a','2026-10-24T02:00:00Z'),entry);
 db.prepare('INSERT INTO runtime_memory_recalls VALUES(?,?,?)').run('f'.repeat(32),origin('rt-other','2026-10-24T05:00:00Z'),entry);
 db.prepare('INSERT INTO runtime_memory_writes VALUES(?,?,?,?,?)').run('d'.repeat(32),'update',origin('rt-a','2026-10-24T03:00:00Z'),entry,entry);
 db.prepare('INSERT INTO runtime_memory_writes VALUES(?,?,?,?,?)').run('e'.repeat(32),'delete',origin('rt-a','2026-10-24T04:00:00Z'),null,entry);
 db.close();
 const adapter=new HermesMemoryAdapter({databasePath:path,sourceId:'test',project:null});
 const result=adapter.readSessionEvents('rt-a');
 expect(result.events.map(e=>e.kind)).toEqual(['delete','update','injected','add']);
 expect(result.events.every(e=>e.origin.platformSessionId==='rt-a')).toBe(true);
 expect(result.events[0]?.entry.content).toBe('saved');
 expect(result.events[0]?.entry.content).toBe('saved');
 expect(result.events[1]?.previous?.content).toBe('saved');
 expect(result.hasMore).toBe(false);
 const more=new DatabaseSync(path);
 for(let i=0;i<105;i++)more.prepare('INSERT INTO runtime_memory_recalls VALUES(?,?,?)').run(i.toString(16).padStart(32,'0'),origin('rt-a','2026-10-24T03:00:00.000Z'),entry);
 more.close();
 const first=adapter.readSessionEvents('rt-a'),second=adapter.readSessionEvents('rt-a',first.nextCursor!);
 expect(first.events).toHaveLength(100);expect(second.events).toHaveLength(9);
 expect(new Set([...first.events,...second.events].map(e=>e.id)).size).toBe(109);
 expect(second.nextCursor).toBe(null);
 expect(()=>adapter.readSessionEvents('rt-a','["invalid","invalid"]')).toThrow('Invalid memory cursor');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
