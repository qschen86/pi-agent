import type {SessionSyncJournal,SyncResource,SyncResponse,SyncSource,SyncWindow} from './session-sync.js';

export interface SessionRestoreResponse {
  schema:1;
  resource:SyncResource;
  partition:string|null;
  display:{allowed:true};
  control:{requiresLatestState:true};
  incremental:{supported:boolean;protocolVersion:1};
  candidate:{accepted:boolean;discardReason?:string};
  sync:SyncResponse|null;
}

const recoverableResets=new Set(['epoch','range','log-missing','log-recreated','cursor-expired']);

/** Called only between route-level authorization checks. A hint/cursor grants no access. */
export async function sessionRestore(input:{
  resource:SyncResource;
  partition:string|null;
  candidatePartition?:string;
  cursor?:string;
  window:SyncWindow;
  sync?:{enabled:boolean;journal:SessionSyncJournal;source:SyncSource};
}):Promise<SessionRestoreResponse>{
  const {resource,partition,window,sync}=input;
  const candidateMatches=!!input.cursor && !!partition && input.candidatePartition===partition;
  const response:SessionRestoreResponse={schema:1,resource,partition,display:{allowed:true},control:{requiresLatestState:true},incremental:{supported:!!sync?.enabled,protocolVersion:1},candidate:{accepted:false,...(input.cursor&&!candidateMatches?{discardReason:'partition'}:{})},sync:null};
  if(!sync?.enabled)return response;
  let cursor=candidateMatches?input.cursor:undefined,discardReason:string|undefined=response.candidate.discardReason;
  let result:SyncResponse;
  try {
    // resume includes authoritative terminal state even when the body is unchanged.
    result=await sync.journal.sync(resource,sync.source,window,cursor,undefined,!!cursor);
  }catch(e){
    if(!cursor||(e as {code?:string}).code!=='SYNC_CURSOR')throw e;
    discardReason='invalid-cursor';cursor=undefined;
    result=await sync.journal.sync(resource,sync.source,window);
  }
  // One bounded retry inside this HTTP request. Unknown sources, busy/oversized
  // responses and capacity failures retain reset-required, never fake unchanged.
  if(cursor&&result.mode==='reset-required'&&recoverableResets.has(result.resetReason??'')){
    discardReason=result.resetReason;cursor=undefined;
    result=await sync.journal.sync(resource,sync.source,window);
  }
  if(cursor&&result.mode==='reset-required')discardReason=result.resetReason??'reset';
  response.candidate={accepted:!!cursor&&['delta','unchanged'].includes(result.mode),...(discardReason?{discardReason}:{})};
  response.sync=result;
  return response;
}
