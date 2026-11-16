import type { MemoryPort } from './port.js';
import { MemoryStore } from './store.js';
import { MemoryError, type MemoryTrigger } from './types.js';
/** Read outside the mutex, commit each scope independently, then retry failures without replaying successful scopes. */
export async function syncMemory(store:MemoryStore,port:MemoryPort,trigger:MemoryTrigger,repositoryRoot?:string,signal?:AbortSignal):Promise<void>{
 const snapshots=await port.read(trigger.workspace,repositoryRoot,signal);
 if(snapshots.project && (snapshots.global.sourceId!==snapshots.project.sourceId || snapshots.global.databaseIdentity!==snapshots.project.databaseIdentity))throw new MemoryError('invalid-output');
 let failure:unknown=snapshots.projectError;
 for(const snapshot of [snapshots.global,snapshots.project].filter(s=>s!==null)){
  try{store.commit(snapshot,trigger);}catch(error){failure=error;}
 }
 if(failure)throw failure;
}
