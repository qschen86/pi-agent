import {createRequire} from 'node:module';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Connection,Grant,Execution,ApprovalRequest,AuditRecord} from './contracts.js';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const TABLES=['connectors','connections','capabilities','grants','app_bindings','executions','approval_requests','subscriptions','sync_cursors','sync_events','audit_records'] as const;
type Table=typeof TABLES[number];
export class GatewayStore {
 readonly db:InstanceType<typeof DatabaseSync>;
 constructor(file:string){
  mkdirSync(dirname(file),{recursive:true,mode:0o700});this.db=new DatabaseSync(file);chmodSync(file,0o600);
  this.db.exec('PRAGMA busy_timeout=2000; PRAGMA journal_mode=DELETE;');
  const version=Number(this.db.prepare('PRAGMA user_version').get()?.user_version??0);
  if(version>1){this.db.close();throw new Error('Unsupported capability schema');}
  this.db.exec('BEGIN IMMEDIATE');try{
   for(const table of TABLES)this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
   this.db.exec('PRAGMA user_version=1; COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 put<T extends {id:string}>(table:Table,value:T){this.db.prepare(`INSERT INTO ${table}(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(value.id,JSON.stringify(value));}
 get<T>(table:Table,id:string):T|undefined{const row=this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);return row?JSON.parse(String(row.data)) as T:undefined;}
 list<T>(table:Table):T[]{return this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid DESC LIMIT 5000`).all().map(row=>JSON.parse(String(row.data)) as T);}
 connection(id:string){return this.get<Connection>('connections',id);}
 connections(){return this.list<Connection>('connections');}
 grants(){return this.list<Grant>('grants');}
 execution(value:Execution){this.put('executions',value);}
 approval(value:ApprovalRequest){this.put('approval_requests',value);}
 audit(value:Omit<AuditRecord,'id'|'at'>){const row={...value,id:randomUUID(),at:new Date().toISOString()};this.put('audit_records',row);return row;}
 close(){this.db.close();}
}
