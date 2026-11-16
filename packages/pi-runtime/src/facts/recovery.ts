import {readFile} from 'node:fs/promises';import {withMemoryLock} from '../hermes-extension.js';import type {FactDependencies} from './coordinator.js';
export async function fileContent(path:string):Promise<string|null>{try{return await readFile(path,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
export async function recoverFacts(deps:FactDependencies):Promise<{recovered:number;drifted:number}>{return withMemoryLock(deps.lockPath,async()=>{
 let recovered=0,drifted=0;
 for(const c of deps.ledger.pendingCommits()){
  const states=await Promise.all(c.files.map(async f=>{const actual=await fileContent(f.path);return actual===f.after?'new':actual===f.before?'old':'drift';}));
  if(states.includes('drift')){deps.ledger.setCommitState(c.id,'recovery_required','external-drift');drifted++;continue;}
  try{const missing=c.files.filter((_,i)=>states[i]==='old');if(missing.length)await deps.projection.publish(missing);await deps.projection.sync(c.files);if(!await deps.projection.verify(c.files))throw new Error('recovery-verification-failed');deps.ledger.finishCommit(c.id);recovered++;}
  catch(e){deps.ledger.setCommitState(c.id,'recovery_required',e instanceof Error?e.message:'recovery-failed');throw e;}
 }
 return {recovered,drifted};
});}

/** A restored canonical file is re-indexed before a persistent runtime-owned block is cleared. */
export async function recoverFactScopeBlocks(deps:FactDependencies):Promise<{recovered:number;drifted:number}>{return withMemoryLock(deps.lockPath,async()=>{
 const {inspectFactIntegrity,factScopeKey}=await import('../../../runtime-memory/src/fact-integrity.js');let recovered=0,drifted=0;
 for(const block of deps.ledger.blockedScopes()){
  const current=deps.ledger.allCurrent().filter(r=>factScopeKey(r.fact.scope.project,r.fact.scope.target)===block.key),integrity=inspectFactIntegrity(current);
  if(!current.length||integrity.blocked.has(block.key)){drifted++;continue;}
  const paths=[...new Set(current.map(r=>r.projectionPath!))],files=[];
  for(const path of paths){const content=await fileContent(path);if(content===null)throw new Error('projection-unavailable');files.push({path,before:content,after:content});}
  await deps.projection.sync(files);if(!await deps.projection.verify(files))throw new Error('restored-projection-verification-failed');deps.ledger.clearScopeBlock(block.key);recovered++;
 }
 return {recovered,drifted};
});}
