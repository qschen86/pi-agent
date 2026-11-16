import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { initializeHermesProfile } from '../src/hermes-profile.js';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
it('CLI discovers scope without SQLite and keeps legacy global reads while supporting project-only reads',()=>{
 const root=mkdtempSync(join(tmpdir(),'memory-cli-')), workspace=join(root,'alpha'), memory=join(root,'memory');
 try {
  mkdirSync(workspace); initializeHermesProfile(memory);
  const permission=join(root,'node_modules/@gotgenes/pi-permission-system'), hermes=join(root,'node_modules/pi-hermes-memory');
  for(const [pkg,name,version] of [[permission,'@gotgenes/pi-permission-system','40.2.2'],[hermes,'pi-hermes-memory','0.9.10']]){
   mkdirSync(join(pkg!,'src'),{recursive:true}); writeFileSync(join(pkg!,'package.json'),JSON.stringify({name,version})); writeFileSync(join(pkg!,'src/index.ts'),'');
  }
  writeFileSync(join(permission,'src/service.ts'),'');
  const profile=join(root,'profile.json'); writeFileSync(profile,JSON.stringify({version:1,permissionPackage:permission,memory:{packageRoot:hermes,storeRoot:memory}}));
  const run=(...args:string[])=>spawnSync(process.execPath,['packages/pi-runtime/bin/pi-runtime.mjs','--profile',profile,'--cwd',workspace,...args],{encoding:'utf8',env:{...process.env,PI_RUNTIME_PROFILE:profile}});
  const scope=run('--memory-scope'); expect(scope.status,scope.stderr).toBe(0); expect(JSON.parse(scope.stdout)).toMatchObject({version:1,project:'alpha'});
  const db=new DatabaseSync(join(memory,'data/global/sessions.db'));
  db.exec(`CREATE TABLE memories(id INTEGER PRIMARY KEY,project TEXT,target TEXT,category TEXT,content TEXT,failure_reason TEXT,tool_state TEXT,corrected_to TEXT,created TEXT); INSERT INTO memories VALUES(1,NULL,'user',NULL,'global',NULL,NULL,NULL,'today'),(2,'alpha','memory',NULL,'project',NULL,NULL,NULL,'today')`); db.close();
  const projects=run('--memory-projects'); expect(projects.status,projects.stderr).toBe(0); expect(JSON.parse(projects.stdout)).toEqual({version:1,projects:['alpha']});
  const audit=new DatabaseSync(join(memory,'data/global/sessions.db'));audit.exec('CREATE TABLE runtime_memory_writes(seq INTEGER PRIMARY KEY,event_id TEXT,memory_id TEXT,kind TEXT,origin TEXT,before_entry TEXT,after_entry TEXT)');audit.close();
  const enriched=run('--memory-snapshot','--memory-provenance');expect(enriched.status,enriched.stderr).toBe(0);expect(JSON.parse(enriched.stdout).writes).toEqual([]);
  const legacy=run('--memory-snapshot');expect(JSON.parse(legacy.stdout).writes).toBeUndefined(); expect(legacy.status,legacy.stderr).toBe(0); expect(JSON.parse(legacy.stdout).entries.map((e:any)=>e.content)).toEqual(['global']);
  const project=run('--memory-snapshot','--memory-project','alpha','--memory-snapshot-scope','project'); expect(project.status,project.stderr).toBe(0); expect(JSON.parse(project.stdout)).toMatchObject({scope:'project',entries:[{content:'project'}]});
  const invalid=run('--memory-snapshot','--memory-snapshot-scope','project'); expect(invalid.status).not.toBe(0); expect(invalid.stdout).toBe('');
 } finally {rmSync(root,{recursive:true,force:true});}
});
