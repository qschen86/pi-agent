/** Standalone trusted integration, copied into the read-only guard directory. */
import {AsyncLocalStorage} from 'node:async_hooks';
type Recall = {db:any; rows:any[]};
type WriteContext = Record<string,unknown> & {recall?:Recall};
const context=new AsyncLocalStorage<WriteContext>();
const factCommit=new AsyncLocalStorage<string>();
export function withHermesFactCommit<T>(id:string,fn:()=>Promise<T>):Promise<T>{return factCommit.run(id,fn);}
const origin=()=>{const {recall:_,...value}=context.getStore()??{};return JSON.stringify({platformSessionId:null,nativeSessionId:null,turnId:null,provider:null,model:null,trigger:'unknown',...value,...(factCommit.getStore()?{factCommitId:factCommit.getStore()}:{}),writtenAt:new Date().toISOString()});};
const patched=new WeakSet<object>(), installed=new WeakSet<object>();
const columns=['id','project','target','category','content','failure_reason','tool_state','corrected_to','created'];
/** TEMP triggers are connection-local: other/older Hermes processes never depend on our SQL function.
 * The audit insert is in the same SQLite transaction as the memory mutation, including rollback. */
export function installHermesProvenance(Manager:any,pi:any,source:{platformSessionId?:string;turnId?:string}) {
 if(!patched.has(Manager.prototype)){
  const getDb=Manager.prototype.getDb;
  Manager.prototype.getDb=function(){
   const db=getDb.call(this);
   if(!installed.has(db)){
    const register=db.function?.bind(db);
    if(!register)throw new Error('Hermes provenance requires SQLite scalar functions');
    register('runtime_memory_origin',origin);
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_memory_writes(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,memory_id TEXT NOT NULL,kind TEXT NOT NULL,origin TEXT NOT NULL,before_entry TEXT,after_entry TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_memory_recalls(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,origin TEXT NOT NULL,entry TEXT NOT NULL)`);
    db.exec(`CREATE INDEX IF NOT EXISTS runtime_memory_write_session ON runtime_memory_writes(json_extract(origin,'$.platformSessionId')); CREATE INDEX IF NOT EXISTS runtime_memory_add_session ON runtime_memory_writes(json_extract(origin,'$.platformSessionId')) WHERE kind='add'; CREATE INDEX IF NOT EXISTS runtime_memory_recall_session ON runtime_memory_recalls(json_extract(origin,'$.platformSessionId'))`);
    // Hermes 0.9.10 returns the first nonempty search query unchanged. Capture complete
    // rows inside this tool's async context, then commit only after successful delivery.
    const prepare=db.prepare.bind(db);
    db.prepare=(...args:any[])=>{
     const stmt=prepare(...args),all=stmt.all.bind(stmt);
     stmt.all=(...params:any[])=>{
      const rawRows=all(...params);const rows=/memory_fts MATCH|content LIKE/.test(String(args[0]))&&db.runtimeFactFilter?db.runtimeFactFilter(rawRows):rawRows,active=context.getStore();
      if(active?.tool==='memory_search' && rows.length && rows.every((r:any)=>columns.every(c=>c in r))){
       if(/memory_fts MATCH/.test(String(args[0]))) {active.queryMethod='fts5';active.effectiveQuery=params[0];}
       else if(/content LIKE/.test(String(args[0]))) {active.queryMethod='literal';active.effectiveQuery=params[0];}
       active.recall={db,rows:rows.map((r:any)=>Object.fromEntries(columns.map(c=>[c,c==='id'?String(r[c]):r[c]])))};
      }
      return rows;
     };
     return stmt;
    };
    const json=(ref:string)=>`json_object(${columns.map(c=>`'${c}',${c==='id'?`CAST(${ref}.${c} AS TEXT)`:`${ref}.${c}`}`).join(',')})`;
    for(const [op,kind,ref,before,after] of [['INSERT','add','NEW','NULL',json('NEW')],['UPDATE','update','NEW',json('OLD'),json('NEW')],['DELETE','delete','OLD',json('OLD'),'NULL']]){
     const changed=op==='UPDATE'?`WHEN ${columns.filter(c=>c!=='id').map(c=>`OLD.${c} IS NOT NEW.${c}`).join(' OR ')}`:'';
     db.exec(`CREATE TEMP TRIGGER runtime_memory_${op.toLowerCase()} AFTER ${op} ON main.memories ${changed} BEGIN INSERT INTO runtime_memory_writes(event_id,memory_id,kind,origin,before_entry,after_entry) VALUES(lower(hex(randomblob(16))),CAST(${ref}.id AS TEXT),'${kind}',runtime_memory_origin(),${before},${after}); END`);
    }
    installed.add(db);
   }
   return db;
  };
  patched.add(Manager.prototype);
 }
 const run=(ctx:any,trigger:string,fn:(ctx:any)=>unknown,tool?:string,params?:any)=>{
  const current={platformSessionId:source.platformSessionId??null,turnId:source.turnId??null,nativeSessionId:ctx?.sessionManager?.getSessionId?.()??null,provider:ctx?.model?.provider??null,model:ctx?.model?.id??null,trigger,...(tool?{tool}:{}),...(tool==='memory_search'?{query:params?.query,queryMethod:'fts5',filters:{...Object.fromEntries(['project','target','category'].filter(k=>params?.[k]!==undefined).map(k=>[k,params[k]])),limit:Math.min(params?.limit||10,20)}}:{})};
  // Maintenance may use an override/fallback model. Record the model actually selected for
  // authentication in this async task, rather than the conversation's configured model.
  const registry=ctx?.modelRegistry;
  const wrapped=registry?new Proxy(registry,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return (...args:any[])=>{if(['getApiKeyAndHeaders','getApiKey'].includes(String(key)) && args[0]?.id){current.model=args[0].id;current.provider=args[0].provider;}return value.apply(target,args);};}}):registry;
  const next=ctx?new Proxy(ctx,{get(target,key){return key==='modelRegistry'?wrapped:Reflect.get(target,key,target);}}):ctx;
  return context.run(current,()=>fn(next));
 };
 return {...pi,
  on(event:string,handler:any){
   // Hermes is pinned: registration sites distinguish two otherwise identical turn_end hooks.
   // Unknown/new registration sites deliberately retain the generic lifecycle label.
   const site=new Error().stack??'';
   const supplied=['background-review','correction-save','turn-end-maintenance','startup-reconciliation','shutdown-flush','pre-compaction-flush','before-agent-start'].includes(handler.runtimeMemoryTrigger)?handler.runtimeMemoryTrigger:undefined;
   const trigger=supplied??(event==='turn_end' && /[\/]handlers[\/]background-review\.[cm]?[jt]s/.test(site)?'background-review':event==='turn_end' && /[\/]handlers[\/]correction-detector\.[cm]?[jt]s/.test(site)?'correction-save':({'session_start':'startup-reconciliation','before_agent_start':'before-agent-start','session_shutdown':'shutdown-flush','session_before_compact':'pre-compaction-flush','turn_end':'turn-end-maintenance'} as Record<string,string>)[event]??'unknown');
   return pi.on(event,(value:any,ctx:any)=>run(ctx,trigger,next=>handler(value,next)));
  },
  registerTool(tool:any){return pi.registerTool({...tool,execute:(id:any,params:any,signal:any,update:any,ctx:any)=>run(ctx,'memory-tool',async next=>{
    const result=await tool.execute(id,params,signal,update,next);
    const recall=context.getStore()?.recall;
    if(tool.name==='memory_search' && !signal?.aborted && !result?.isError && result?.details?.success===true && recall && result.details.count===recall.rows.length){
     const db=recall.db,stamp=origin();
     db.exec('SAVEPOINT runtime_recall');
     try{
      const insert=db.prepare('INSERT INTO runtime_memory_recalls(event_id,origin,entry) VALUES(lower(hex(randomblob(16))),?,?)');
      for(const entry of recall.rows)insert.run(stamp,JSON.stringify(entry));
      db.exec('RELEASE runtime_recall');
     }catch(e){db.exec('ROLLBACK TO runtime_recall; RELEASE runtime_recall');throw e;}
    }
    return result;
   },tool.name,params)});}
 };
}
