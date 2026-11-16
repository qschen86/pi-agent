"use strict";
const sessionDeltas = { views:new Map(), sizes:new Map(), bytes:0, flights:new Map(), reads:new Map(), epoch:0, capabilities:null, restoreSupported:null, unsupported:new Set() };
/**
 * 增量同步的瞬时失败（超时 / 网关 / Failed to fetch）按指数退避重试；
 * 页面隐藏、资源切换或同步已被取代时立即停止。SYNC_DISABLED 不是瞬时故障，不重试。
 */
const SESSION_SYNC_RETRY_WAITS = [800, 1600, 3200];
function sessionSyncCacheDelete(key) {
  sessionDeltas.bytes-=sessionDeltas.sizes.get(key)||0;
  sessionDeltas.sizes.delete(key);sessionDeltas.views.delete(key);
}
function sessionSyncKey(resource, window) { return JSON.stringify([resource.kind,resource.id,window]); }
function sessionSyncCurrent(resource,generation,epoch) { return epoch===sessionDeltas.epoch && (generation === null ? sessionLiveHas(resource) : resource.kind==='rt'?rtReadCurrent(resource.id,generation):roomCurrent(resource.id,generation)); }
function sessionSyncInvalidate(resource) {
  sessionDeltas.epoch++;
  if (typeof sessionLiveStop === 'function') sessionLiveStop(resource);
  if (!resource) {sessionDeltas.views.clear();sessionDeltas.sizes.clear();sessionDeltas.bytes=0;sessionDeltas.unsupported.clear();return;}
  const prefix=JSON.stringify([resource.kind,resource.id]).slice(0,-1)+',';
  for(const key of sessionDeltas.views.keys())if(key.startsWith(prefix))sessionSyncCacheDelete(key);
}
async function sessionSyncSupported() {
  if (!sessionDeltas.capabilities) sessionDeltas.capabilities = api('/api/session-sync/capabilities').then(c=>{sessionDeltas.restoreSupported=c.restore?.supported===true&&c.restore?.schema===1;return c.protocolVersion===1 || c.incremental?.protocolVersion===1 ? !!c.incremental?.supported : false;}).catch(e=>{sessionDeltas.capabilities=null;if(e.status===404){sessionDeltas.restoreSupported=false;return false;}throw e;});
  return sessionDeltas.capabilities;
}
// A foreground navigation owns one authority request, shared by view/messages.
function sessionAuthorityRestorePrepare(resource,generation) {
  const state=resource.kind==='rt'?ui.rt:ui.room,epoch=sessionDisk.epoch,old=state.diskRestoreFlight;
  if(old?.id===resource.id&&old.generation===generation&&(old.epoch===epoch||old.authorizedEpoch===epoch))return old;
  const flight={id:resource.id,generation,epoch,authorizedEpoch:null,combined:true,consumed:false,promise:null};
  let dispatched;flight.dispatched=new Promise(resolve=>dispatched=resolve);
  state.diskRestoreFlight=flight;state.diskRestorePending=true;
  const candidateWork=sessionPersistenceCandidate(resource).catch(()=>null);
  const current=()=>sessionDiskCurrent(resource,generation)&&sessionDisk.epoch===(flight.authorizedEpoch??epoch);
  flight.promise=(async()=>{
    // Bounded disk preparation never holds
    // the network indefinitely when IndexedDB is blocked or suspended.
    let timer,candidate;
    try{candidate=await Promise.race([candidateWork,new Promise(resolve=>timer=setTimeout(()=>resolve(null),150))]);}finally{clearTimeout(timer);}
    if(!current())return null;
    if(sessionDeltas.restoreSupported===false){state.diskRestoreFlight=null;void sessionRestoreDisplay(resource,generation);return null;}
    // Local-first: show the saved body while the authority request is in flight, but only for the login partition
    // this device last had confirmed. The answer below keeps, or takes away, what was shown.
    const remembered=typeof localFirstPartition==='function'?localFirstPartition():null;
    // Nothing usable on disk for this session (never opened here, beyond the saved set, or saved
    // under another login): the shell may still have the tail it kept current while the app was
    // closed. Same rule — only the partition this device already had confirmed.
    if(remembered&&sessionDisk.enabled&&typeof localFirstNativeTail==='function'&&(!candidate||candidate.partition!==remembered)){
      const tail=await Promise.race([localFirstNativeTail(resource).catch(()=>null),new Promise(resolve=>timer=setTimeout(()=>resolve(null),250))]).finally(()=>clearTimeout(timer));
      if(!current())return null;
      if(tail&&!state.diskDisplay&&(resource.kind==='room'||state.events.length===0))candidate={partition:remembered,display:tail.display,fromNative:true};
    }
    if(candidate&&remembered&&candidate.partition===remembered&&sessionDisk.enabled&&!state.view&&!state.diskDisplay&&(resource.kind==='room'||state.events.length===0)){
      sessionApplyDiskDisplay(resource,state,candidate.display);state.optimisticDisplay=true;renderMain();
    }
    const params=new URLSearchParams({limit:'50'}),base=candidate?.display.sync;
    if(base){params.set('cursor',base.cursor);params.set('candidatePartition',candidate.partition);}
    let access;
    const request=api((resource.kind==='rt'?'/api/runtime-sessions/':'/api/rooms/')+encodeURIComponent(resource.id)+'/restore?'+params);
    dispatched();
    // The authority request owns the first available slot, even under the
    // conservative three-read budget. Discovery remains a parallel shared read.
    void sessionSyncSupported().catch(()=>{});
    try{access=await request;}
    catch(e){
      if(!current())return null;
      // Only an absent endpoint permits old-server fallback, never a missing resource.
      if(e.status===404&&!e.code){sessionDeltas.restoreSupported=false;state.diskRestoreFlight=null;void sessionRestoreDisplay(resource,generation);return null;}
      throw e;
    }
    if(!current())return null;
    if(access?.schema!==1||access.resource?.kind!==resource.kind||access.resource.id!==resource.id||!(access.partition===null||typeof access.partition==='string')||access.display?.allowed!==true||access.control?.requiresLatestState!==true||access.incremental?.protocolVersion!==1||typeof access.incremental.supported!=='boolean'||typeof access.candidate?.accepted!=='boolean')return null;
    sessionPersistenceAuthorize(access.partition);flight.authorizedEpoch=sessionDisk.epoch;
    // Shown for another login, or for none: take it away.
    if(state.optimisticDisplay&&(!access.partition||access.partition!==candidate?.partition)&&typeof sessionRevertOptimistic==='function')sessionRevertOptimistic(resource,state);
    state.optimisticDisplay=false;
    state.diskAuthorized=!!access.partition;state.diskAuthorizationEpoch=sessionDisk.epoch;
    const accepted=!!(access.partition&&candidate?.partition===access.partition&&access.candidate.accepted&&base);
    if(accepted&&sessionDisk.enabled&&!state.view&&(resource.kind==='room'||state.events.length===0)){
      sessionApplyDiskDisplay(resource,state,candidate.display);renderMain();
    }
    if(!access.incremental.supported)return {response:null,base:null};
    return {response:access.sync,base:accepted?{...base,state:null,versions:{}}:null};
  })().catch(async e=>{
    if(current()&&[401,403,404,410].includes(e.status)){
      await sessionPersistenceInvalidate(e.status===401?undefined:resource);
      if(sessionDiskCurrent(resource,generation)){
        if(resource.kind==='rt')rtReadFailure(resource.id,generation,e);
        else {state.diskDisplay=null;state.diskAuthorized=false;state.view=null;state.statusConfirmed=false;roomStop();}
      }
    }
    throw e;
  }).finally(()=>{dispatched();if(state.diskRestoreFlight===flight)state.diskRestorePending=false;});
  return flight;
}
function sessionRuntimeRestorePrepare(resource,generation){return sessionAuthorityRestorePrepare(resource,generation);}
function sessionSyncMerge(base,responses) {
  let current=base, changed=new Set(),deleted=new Set(),removed=new Set(),moved=new Set(),stateChanged=false;
  for(const response of responses){
    if(response.protocolVersion!==1||!response.resource||!response.epoch||typeof response.nextCursor!=='string')throw new Error('同步协议无效');
    if(current&&(current.resource.id!==response.resource.id||current.resource.kind!==response.resource.kind||current.epoch!==response.epoch||response.baseCursor!==current.cursor))throw new Error('增量基线不匹配');
    let items,versions;
    if(response.mode==='snapshot'){
      if(!Array.isArray(response.items)||!response.state||!response.window||response.hasMore)throw new Error('基线不完整');
      items=new Map(response.items.map(i=>[i.id,i]));versions={};for(const id of items.keys())changed.add(id);stateChanged=true;
    }else{
      if(!current||!['delta','unchanged'].includes(response.mode)||!Array.isArray(response.changes))throw new Error('增量不完整');
      items=new Map(current.items.map(i=>[i.id,i]));versions={...current.versions};
      for(const change of response.changes){
        if(!Number.isSafeInteger(change.revision)||typeof change.id!=='string'||!['upsert','delete'].includes(change.op))throw new Error('变化格式无效');
        if((versions[change.id]??-1)>=change.revision)continue;
        versions[change.id]=change.revision;
        if(change.op==='delete'){items.delete(change.id);changed.delete(change.id);deleted.add(change.id);if(change.reason==='window'){removed.delete(change.id);moved.add(change.id);}else{removed.add(change.id);moved.delete(change.id);}}
        else {const item=change.item;if(!item||item.id!==change.id||!Number.isFinite(item.seq)||!item.value)throw new Error('正文变化不完整');if(items.get(item.id)?.revision>item.revision)continue;items.set(item.id,item);changed.add(item.id);deleted.delete(item.id);removed.delete(item.id);moved.delete(item.id);}
      }
      if(!response.hasMore&&response.mode==='delta'&&(!response.state||!response.window))throw new Error('终点状态不完整');
      if(response.state)stateChanged ||= JSON.stringify(current.state)!==JSON.stringify(response.state);
    }
    if(!response.hasMore)for(const id of Object.keys(versions))if(!items.has(id))delete versions[id];
    current={resource:response.resource,epoch:response.epoch,cursor:response.nextCursor,items:[...items.values()].sort((a,b)=>a.seq-b.seq||a.id.localeCompare(b.id)),state:response.state??current?.state,window:response.window??current?.window,versions,changedIds:[...changed],deletedIds:[...deleted],removedIds:[...removed],movedIds:[...moved],stateChanged};
  }
  return current;
}
async function sessionSyncRead(resource,window,generation) {
  const epoch=sessionDeltas.epoch,key=sessionSyncKey(resource,window);
  const state=resource.kind==='rt'?ui.rt:ui.room;
  const restoring=generation!==null&&state?.diskRestoreFlight?.combined&&!state.diskRestoreFlight.consumed;
  if(sessionDeltas.unsupported.has(`${resource.kind}:${resource.id}`)||(!restoring&&!await sessionSyncSupported())||!sessionSyncCurrent(resource,generation,epoch))return null;
  // Resource/navigation generations get separate flights; older reads never donate results to a new view.
  const flightKey=key+':'+generation+':'+epoch,old=sessionDeltas.flights.get(flightKey);
  if(old){old.again=true;return old.promise;}
  const flight={promise:null,again:false};
  sessionDeltas.reads.set(key,flight);
  const current=()=>sessionSyncCurrent(resource,generation,epoch)&&sessionDeltas.reads.get(key)===flight;
  const readPages=async()=>{
    let base=sessionDeltas.views.get(key)||null;
    let firstResponse;
    const restore=generation!==null&&window.limit===50&&!window.before&&!window.kind?state?.diskRestoreFlight:null;
    if(restore?.combined&&restore.id===resource.id&&restore.generation===generation&&!restore.consumed){
      const initial=await restore.promise;
      if(!current()||(restore.authorizedEpoch??restore.epoch)!==sessionDisk.epoch)return null;
      restore.consumed=true;restore.promise=Promise.resolve(null);
      if(!initial&&!await sessionSyncSupported())return null;
      if(initial){base=initial.base;firstResponse=initial.response;if(!firstResponse)return null;}
    }
    if (!base&&!firstResponse) base=await sessionSyncRestore(resource,window,generation,epoch);
    if (!current()) return null;
    const responses=[];
    let cursor=base?.cursor,target,bytes=0,reset=false;
    const path=(resource.kind==='rt'?'/api/runtime-sessions/':'/api/rooms/')+encodeURIComponent(resource.id)+'/sync';
    for(let page=0;page<10;page++){
      const params=new URLSearchParams(Object.entries(window).filter(([,v])=>v!=null).map(([k,v])=>[k,String(v)]));
      if(cursor)params.set('cursor',cursor);if(target)params.set('targetCursor',target);
      if (base && !base.state) params.set('resume','1');
      let response;
      // 手机回前台后网络还没就绪时，先按退避重试，避免目录 / 同步整批失败后只能等下一次轮询。
      const readPage=()=>api(path+'?'+params);
      try{response=page===0&&firstResponse?firstResponse:(typeof retryTransientRead==='function'?await retryTransientRead(readPage, current, SESSION_SYNC_RETRY_WAITS, (e) => e?.code !== 'SYNC_DISABLED' && (typeof transientReadError !== 'function' || transientReadError(e))):await readPage());}catch(e){if(e.status===503&&e.code==='SYNC_DISABLED'){sessionDeltas.capabilities=null;sessionSyncCacheDelete(key);return null;}if(e.code==='SYNC_CURSOR'&&!reset){reset=true;base=null;cursor=undefined;target=undefined;responses.length=0;continue;}throw e;}
      if(!current())return null;
      if(response.resource?.id!==resource.id||response.resource?.kind!==resource.kind||response.protocolVersion!==1){sessionSyncCacheDelete(key);return null;}
      if(response.mode==='reset-required'){
        sessionSyncCacheDelete(key);
        if(response.resetReason==='untracked-source')sessionDeltas.unsupported.add(`${resource.kind}:${resource.id}`);
        if(reset || ['untracked-source','busy','oversized-baseline','oversized-change','budget'].includes(response.resetReason))return null;
        reset=true;base=null;cursor=undefined;target=undefined;responses.length=0;continue;
      }
      bytes+=new TextEncoder().encode(JSON.stringify(response)).byteLength;
      if(bytes>10*1024*1024||target&&response.targetCursor!==target){sessionSyncCacheDelete(key);return null;}
      target=response.targetCursor;responses.push(response);cursor=response.nextCursor;
      if(!response.hasMore){
        // A validated heartbeat cannot change body, state, window or resume cursor.
        // Touch the LRU without serializing or rewriting the retained transcript.
        if(base?.state && responses.length===1 && response.mode==='unchanged' && response.epoch===base.epoch && response.baseCursor===base.cursor && response.nextCursor===base.cursor && Array.isArray(response.changes) && !response.changes.length && response.state===undefined && response.window===undefined){
          sessionDeltas.views.delete(key);sessionDeltas.views.set(key,base);
          const applied={...base,noticeCoverage:response.noticeCoverage,readGeneration:generation,readEpoch:epoch,changedIds:[],deletedIds:[],removedIds:[],movedIds:[],stateChanged:false,unchanged:true};sessionDeltas.views.set(key,applied);return applied;
        }
        let applied;
        try{applied=sessionSyncMerge(base,responses);}catch{sessionSyncCacheDelete(key);return null;}
        if(!current())return null;
        applied.noticeCoverage=responses[0]?.noticeCoverage;applied.readGeneration=generation;applied.readEpoch=epoch;
        sessionSyncCachePut(key,applied);
        if (!applied.state) {sessionSyncCacheDelete(key);return null;}
        void sessionSyncPersist(resource,window,applied);
        // Cached sync resources share the same count/byte ceiling as the reading layer.

        return applied;
      }
    }
    sessionSyncCacheDelete(key);return null;
  };
  flight.promise=(async()=>{
    let result,unchanged=true;const removed=new Set();
    do {
      flight.again=false;result=await readPages();if(!result)return null;
      unchanged &&= result.unchanged===true;
      for(const id of result.removedIds || [])removed.add(id);
      for(const id of result.changedIds || [])removed.delete(id);
      for(const id of result.movedIds || [])removed.delete(id);
    } while(flight.again&&current());
    return {...result,removedIds:[...removed],unchanged};
  })().finally(()=>{sessionDeltas.flights.delete(flightKey);if(sessionDeltas.reads.get(key)===flight)sessionDeltas.reads.delete(key);});
  sessionDeltas.flights.set(flightKey,flight);return flight.promise;
}

async function sessionResumeWait(work) {
  const configured=Number(window.PI_AGENT_RESUME_WAIT_MS);
  const budget=Number.isFinite(configured)?Math.min(1500,Math.max(0,configured)):750;
  let timer;
  try { await Promise.race([work,new Promise(resolve=>timer=setTimeout(resolve,budget))]); }
  finally { clearTimeout(timer); }
}
async function sessionSyncRestore(resource,window,generation,epoch) {
  if (typeof sessionPersistenceRead !== 'function' || !sessionDisk.enabled || window.before || window.kind || !(resource.kind==='rt'?[50,100].includes(window.limit):window.limit===50)) return null;
  // The foreground restore already checked this resource for this navigation/storage epoch.
  // Reuse that authorization, not a previous navigation's or login's permission.
  const state=resource.kind==='rt'?ui.rt:ui.room;
  const foreground=generation!==null && typeof sessionDiskCurrent==='function' && sessionDiskCurrent(resource,generation);
  const restore=foreground?state.diskRestoreFlight:null;
  if(state.diskRestorePending && restore?.id===resource.id){
    // Join the already-running authorized restore for a bounded interval. Never
    // send a saved cursor before that restore has confirmed the login/resource.
    await sessionResumeWait(restore.promise);
    if(!sessionSyncCurrent(resource,generation,epoch) || !sessionDiskCurrent(resource,generation))return null;
  }
  if(state.diskRestorePending||state.memoryDisplay)return null;
  if (typeof sessionDiskCurrent==='function' && sessionSyncCurrent(resource,generation,epoch) && sessionDiskCurrent(resource,generation) && state.diskAuthorized && state.diskAuthorizationEpoch===sessionDisk.epoch && sessionDisk.partition) {
    // A prepared body already carries its resume data. If warming is unfinished,
    // start a fresh server snapshot immediately rather than queueing behind disk I/O.
    const prepared=state.diskDisplay?.sync;
    if(prepared && JSON.stringify(prepared.queryWindow)===JSON.stringify(window))return {...prepared,state:null,versions:{}};
    if(typeof sessionDirectoryAllows==='function' && sessionDirectoryAllows(resource))return null;
    const life=sessionDisk.epoch,hit=await sessionPersistenceRead(resource),base=hit?.display.sync;
    if (!sessionSyncCurrent(resource,generation,epoch) || life!==sessionDisk.epoch || !base || JSON.stringify(base.queryWindow)!==JSON.stringify(window)) return null;
    return {...base,state:null,versions:{}};
  }
  const storageEpoch=sessionDisk.epoch;
  const access=await sessionBootstrap(resource,()=>sessionSyncCurrent(resource,generation,epoch)&&sessionDisk.epoch===storageEpoch);
  if (!access) return null;
  sessionPersistenceAuthorize(access.partition);
  if (!access.partition) return null;
  const life=sessionDisk.epoch;
  const hit=await sessionPersistenceRead(resource),base=hit?.display.sync;
  if (!sessionSyncCurrent(resource,generation,epoch) || life!==sessionDisk.epoch || !base || JSON.stringify(base.queryWindow)!==JSON.stringify(window)) return null;
  return {...base,state:null,versions:{}};
}
async function sessionSyncPersist(resource,window,result,saved) {
  if (typeof sessionPersistenceWrite!=='function' || !sessionDisk.partition || !sessionDisk.enabled || window.before || window.kind) return;
  const state=resource.kind==='rt'?ui.rt:ui.room;
  const snapshot=typeof sessionSnapshotGet==='function'?sessionSnapshotGet(`${resource.kind}:${resource.id}`):null;
  const current=state?.id===resource.id && ui.view===(resource.kind==='rt'?'rt':'rt-room');
  const old=current?state:snapshot;
  const s=result.state?.session || result.state?.room || {};
  await sessionPersistenceWrite(resource,{items:result.items.map(i=>i.value),summary:{id:resource.id,title:s.title,runtimeKind:s.runtimeKind},window:result.window,reading:old?.reading || saved?.reading || {atBottom:true},expanded:old?.openFolds || old?.expanded || saved?.expanded,sync:{...result,noticeCoverage:undefined,readGeneration:undefined,readEpoch:undefined,queryWindow:window}});
}

/*
 * 后台保鲜（会话列表页）：点进会话之前，先把最近几个「本机已有缓存」的会话的新消息补进缓存，
 * 点进去直接显示最新内容，不必等手机在慢链路上走完整套读取。
 * 边界：只在列表页且页面可见时做；最多 5 个会话，一个接一个、中间留空；读取优先级最低（前台读取永远排在前面）、
 * 不重试；从没打开过（没有缓存）的会话不预取；没有新内容时服务端只回一个很小的 unchanged，不写缓存。
 * 离开列表页 / 换登录 / 隐藏页面 / 目录授权过期，立即停止且不写缓存，避免盖掉前台刚读到的更新。
 * 省流量模式（saveData）和离线时不做。
 */
const SESSION_FRESHEN_MAX=5,SESSION_FRESHEN_MAX_PAGES=3,SESSION_FRESHEN_PAUSE_MS=400;
const SESSION_FRESHEN_RECHECK_MS=5*60000,SESSION_FRESHEN_MIN_GAP_MS=20000;
const sessionFreshen={running:false,rerun:null,seen:new Map()};
function sessionFreshenListVisible(){return ui.view==='rt'&&!rtId()&&document.visibilityState!=='hidden';}
function sessionFreshenCandidates(entries){
  const out=[];
  for(const e of Array.isArray(entries)?entries:[]){
    // 比较组 / 群聊不是独立的会话转录；归档的不预取。
    if(!e?.id||e.archived||!e.href?.startsWith('#/rt/')||e.comparisonRef||e.lanes||e.members||e.roomRef)continue;
    out.push(e);if(out.length>=SESSION_FRESHEN_MAX)break;
  }
  return out;
}
async function sessionFreshenRecent(entries,current=()=>true) {
  if(sessionFreshen.running){sessionFreshen.rerun={entries,current};return;}
  if(!sessionFreshenListVisible()||!sessionDisk.enabled||!sessionDisk.partition||navigator.onLine===false||navigator.connection?.saveData)return;
  sessionFreshen.running=true;
  try{
    let job={entries,current};
    while(job){
      sessionFreshen.rerun=null;
      for(const entry of sessionFreshenCandidates(job.entries)){
        if(!sessionFreshenListVisible()||!job.current())break;
        const resource={kind:'rt',id:entry.id},key=sessionLiveKey(resource),seen=sessionFreshen.seen.get(key),now=Date.now();
        if(seen&&(now-seen.at<SESSION_FRESHEN_MIN_GAP_MS||(seen.activity===entry.lastActivityAt&&now-seen.at<SESSION_FRESHEN_RECHECK_MS)))continue;
        if(!sessionDirectoryAllows(resource))continue;
        const result=await sessionFreshenOne(resource,job.current).catch(()=>'failed');
        if(result!=='aborted')sessionFreshen.seen.set(key,{activity:entry.lastActivityAt,at:Date.now()});
        if(result==='aborted')break;
        await new Promise(resolve=>setTimeout(resolve,SESSION_FRESHEN_PAUSE_MS));
      }
      job=sessionFreshen.rerun;
    }
  }finally{sessionFreshen.running=false;}
}
async function sessionFreshenOne(resource,current) {
  const epoch=sessionDisk.epoch,partition=sessionDisk.partition,syncEpoch=sessionDeltas.epoch;
  const alive=()=>current()&&sessionFreshenListVisible()&&epoch===sessionDisk.epoch&&partition===sessionDisk.partition&&syncEpoch===sessionDeltas.epoch&&sessionDirectoryAllows(resource);
  const hit=await sessionPersistenceRead(resource);
  if(!alive())return 'aborted';
  const saved=hit?.display,base=saved?.sync,window={limit:50};
  if(!base||typeof base.cursor!=='string'||JSON.stringify(base.queryWindow)!==JSON.stringify(window))return 'skipped';
  const path='/api/runtime-sessions/'+encodeURIComponent(resource.id)+'/sync';
  const responses=[];let cursor=base.cursor,target;
  for(let page=0;page<SESSION_FRESHEN_MAX_PAGES;page++){
    const params=new URLSearchParams({limit:'50',cursor,resume:'1'});if(target)params.set('targetCursor',target);
    const response=await api(path+'?'+params,{readPriority:2,retry:false});
    if(!alive())return 'aborted';
    if(response.resource?.id!==resource.id||response.resource?.kind!==resource.kind||response.protocolVersion!==1||response.mode==='reset-required'||(target&&response.targetCursor!==target))return 'skipped';
    target=response.targetCursor;responses.push(response);cursor=response.nextCursor;
    if(response.hasMore)continue;
    if(responses.length===1&&response.mode==='unchanged'&&!response.changes?.length&&response.nextCursor===base.cursor)return 'unchanged';
    let applied;try{applied=sessionSyncMerge({...base,state:null,versions:{}},responses);}catch{return 'skipped';}
    if(!applied.state||!alive())return applied.state?'aborted':'skipped';
    await sessionSyncPersist(resource,window,applied,saved);
    // 内存里的预热快照是改之前的：丢掉，点进去走本机缓存读取（读到的就是刚写入的新内容）。
    sessionWarmDisplays.delete(JSON.stringify([resource.kind,resource.id]));
    return 'refreshed';
  }
  return 'skipped'; // 落后太多（超过 3 页）：留给点进去时的完整读取
}

function sessionSyncCachePut(key,value) {
  sessionSyncCacheDelete(key);
  const bytes=new TextEncoder().encode(JSON.stringify(value)).byteLength;if(bytes>10*1024*1024)return;
  sessionDeltas.views.set(key,value);sessionDeltas.sizes.set(key,bytes);sessionDeltas.bytes+=bytes;
  while(sessionDeltas.views.size>12||sessionDeltas.bytes>10*1024*1024)sessionSyncCacheDelete(sessionDeltas.views.keys().next().value);
}

/* One addressed notice stream for the active and bounded background resources. */
const sessionLive={es:null,key:'',targets:new Map(),blocked:new Set(),pending:new Map(),active:0,inflight:new Set(),timer:null,retry:null,epoch:0,enabled:false,shared:false,health:null,failed:new Set(),dirty:new Map(),retryAfter:new Map()};
function sessionLiveHealthy(){
  if([...sessionLive.failed].some(key=>sessionLive.targets.has(key)&&sessionLiveCurrent(sessionLive.targets.get(key))))return false;
  for(const r of sessionLive.targets.values())if(sessionLiveCurrent(r)){const state=r.kind==='rt'?ui.rt:ui.room;if(state?.statusConfirmed===false||state?.syncError)return false;}
  return !!(sessionLive.enabled&&sessionLive.es&&sessionLive.health?.es===sessionLive.es&&sessionLive.health.ready&&Date.now()-sessionLive.health.at<45000);}
function sessionLiveHealthExpiry(){return sessionLive.health?.ready&&sessionLive.health.es===sessionLive.es?sessionLive.health.at+45000:null;}
function sessionLiveRetryFailures(){for(const key of sessionLive.failed){const r=sessionLive.targets.get(key);if(r&&Date.now()>=(sessionLive.retryAfter.get(key)||0))sessionLiveSchedule(r);}}
function sessionLiveHealthChanged(){if(typeof rtUnreadReschedule==='function')rtUnreadReschedule();}
// A read must start after listener installation and every delivered resource notice.
function sessionCoverageValid(c){return c?.version===1&&typeof c.instance==='string'&&c.instance.length>0&&Number.isSafeInteger(c.order)&&c.order>0;}
function sessionCoverageIncludes(read,barrier){return sessionCoverageValid(read)&&sessionCoverageValid(barrier)&&read.instance===barrier.instance&&read.order>=barrier.order;}
async function sessionLiveReadyResource(resource,barrier,currentStream){
  if(!sessionLiveCurrent(resource)){sessionLive.dirty.set(sessionLiveKey(resource),barrier);return;}
  const key=sessionLiveKey(resource),window={limit:50},readKey=sessionSyncKey(resource,window);
  const generation=sessionLiveCurrent(resource)?(resource.kind==='rt'?ui.rt.gen:ui.room.generation):null;
  const flight=sessionDeltas.flights.get(readKey+':'+generation+':'+sessionDeltas.epoch);
  if(sessionCoverageValid(barrier)&&flight)try{await flight.promise;}catch{}
  if(!currentStream()||!sessionLiveHas(resource))return;
  const read=sessionDeltas.views.get(readKey),dirty=sessionLive.dirty.get(key);
  const state=sessionLiveCurrent(resource)?(resource.kind==='rt'?ui.rt:ui.room):null;
  const appliedToView=!state||(read?.readGeneration===(resource.kind==='rt'?state.gen:state.generation)&&read?.readEpoch===sessionDeltas.epoch&&typeof read.cursor==='string'&&state.appliedSyncCursor===read.cursor&&state.appliedSyncEpoch===read.epoch&&!state.trimmedTail&&!state.viewSyncError&&!state.messageSyncError);
  if(appliedToView&&sessionCoverageIncludes(read?.noticeCoverage,barrier)&&(!sessionLive.dirty.has(key)||sessionCoverageIncludes(read.noticeCoverage,dirty))&&state?.statusConfirmed!==false&&!state?.syncError){
    sessionLive.failed.delete(key);sessionLive.retryAfter.delete(key);sessionLive.pending.delete(key);sessionLiveHealthChanged();return;
  }
  sessionLiveSchedule(resource);
}
function sessionLiveKey(resource) {return `${resource.kind}:${resource.id}`;}
function sessionLiveHas(resource) {return sessionLive.enabled && sessionLive.targets.has(sessionLiveKey(resource)) && !sessionLive.blocked.has(sessionLiveKey(resource));}
function sessionLiveCurrent(resource) {
  if(resource.kind==='rt' && (typeof rtSessionVisible==='function' ? !rtSessionVisible() : typeof rtConversationVisible==='function' && !rtConversationVisible()))return false;
  return resource.kind==='rt' ? ui.view==='rt'&&rtId()===resource.id : ui.view==='rt-room'&&ui.room?.id===resource.id;
}
function sessionLiveResources() {
  const resources=new Map();
  if(ui.view==='rt'&&!rtId())return resources;
  const add=r=>{const key=sessionLiveKey(r);if(r.id&&!sessionLive.blocked.has(key)&&resources.size<12)resources.set(key,r);};
  if(ui.view==='rt'&&rtId())add({kind:'rt',id:rtId()});
  if(ui.view==='rt-room'&&ui.room?.id)add({kind:'room',id:ui.room.id});
  for(const e of [...(ui.rt?.notifications || []), ...(ui.rt?.dir?.entries || [])]) if(['creating','running','waiting-input','stopping'].includes(e.status)&&!e.archived) {
    // Directory entries for comparison groups are not standalone transcript resources.
    if(e.roomRef?.roomId)add({kind:'room',id:e.roomRef.roomId});
    else if(e.href?.startsWith('#/rt-room/'))add({kind:'room',id:e.id});
    else if(e.href?.startsWith('#/rt/')&&!e.comparisonRef&&!e.lanes&&!e.members)add({kind:'rt',id:e.id});
  }
  if(typeof sessionSnapshots!=='undefined')for(const key of [...sessionSnapshots.cache.keys()].reverse()) {
    const [kind,...rest]=key.split(':');if(kind==='rt'||kind==='room')add({kind,id:rest.join(':')});
  }
  return resources;
}
function sessionLiveParams(key) { return 'app=1&watch=' + encodeURIComponent(key); }
/**
 * 把会话订阅挂到顶栏那条实时流上（app=1 同一条连接也送页面级 update）。
 * 没有顶栏入口时（旧 embedder 或单独加载 session-sync 的测试）返回 false，走原来的自建流。
 */
function sessionLiveSyncClaim(key) {
  if (typeof window === 'undefined' || typeof window.piLiveClaim !== 'function') return false;
  // 订阅目标没变就不打扰顶栏连接（重连与心跳由 connect() 负责）。
  if (sessionLive.shared && sessionLive.key === key) return true;
  // 之前自建过的流要关掉，否则切换时会短暂留着两条 SSE。
  if (sessionLive.es) { sessionLive.es.close(); sessionLive.es = null; }
  sessionLive.shared = true;
  sessionLive.key = key;
  window.piLiveClaim(sessionLiveParams(key), sessionLiveAttach);
  return true;
}
async function sessionLiveConnect(force=false) {
  const epoch=sessionLive.epoch;
  if(!await sessionSyncSupported()||epoch!==sessionLive.epoch)return false;
  sessionLive.enabled=true;
  // A successful foreground read is a new authorization check for this resource.
  const current=ui.view==='rt'?{kind:'rt',id:rtId()}:ui.view==='rt-room'?{kind:'room',id:ui.room?.id}:null;
  if(current&&(current.kind==='rt'?ui.rt.statusConfirmed:ui.room.statusConfirmed))sessionLive.blocked.delete(sessionLiveKey(current));
  const targets=sessionLiveResources(),key=JSON.stringify([...targets.values()].sort((a,b)=>sessionLiveKey(a).localeCompare(sessionLiveKey(b))));
  sessionLive.targets=targets;
  for(const key of sessionLive.dirty.keys())if(!targets.has(key))sessionLive.dirty.delete(key);
  // 共享流：只登记参数，连接本身由顶栏 connect() 建/重建；参数没变就不会重开。
  if(sessionLiveSyncClaim(key))return true;
  if(sessionLive.es&&sessionLive.key===key){
    // CLOSED 表示浏览器已经放弃，必须新建；OPEN/CONNECTING 直接复用，避免回前台重复重建。
    if(sessionLive.es.readyState!==2){
      const stale=!!sessionLive.health?.ready&&Date.now()-sessionLive.health.at>45000;
      if(!force||!stale)return true;
      sessionLive.es.close();
    }
    sessionLive.es=null;sessionLive.health=null;sessionLiveHealthChanged();
  }
  sessionLive.es?.close();clearTimeout(sessionLive.retry);sessionLive.key=key;
  const es=new EventSource('/api/runtime/stream?watch='+encodeURIComponent(key));sessionLive.es=es;sessionLive.health={es,ready:false,at:0};sessionLiveHealthChanged();
  try {window.piTelemetry?.trackStream?.(es);} catch {}
  sessionLiveAttach(es,()=>sessionLive.es===es&&epoch===sessionLive.epoch);
  return true;
}
/** 把 sync-notice / ready / 目录 / profile 等监听器挂到一条流上（共享流与自建流共用）。 */
function sessionLiveAttach(es,isCurrent) {
  const currentStream=typeof isCurrent==='function'?isCurrent:()=>sessionLive.es===es;
  sessionLive.es=es;sessionLive.health={es,ready:false,at:0};sessionLiveHealthChanged();
  es.addEventListener('sync-notice',event=>{
    if(!currentStream())return;
    try{const update=JSON.parse(event.data),r=update.resource;if(r&&sessionLiveHas(r)){sessionLive.dirty.set(sessionLiveKey(r),update.noticeCoverage);sessionLiveSchedule(r);}}catch{}
  });
  /*
   * 故障诊断 f0e1c2c58c5126dd2：error 处理与 sessionLiveStop（翻页 / 读失败 / 归档都会走到）会把 health 置空，
   * 但共享流的监听器仍挂在这条活着的连接上，心跳每 15 秒继续到达：直接写 health.at 就每次都抛
   * "Cannot set properties of null (setting 'at')"，健康状态也永远停在“未知”。
   * 心跳能到达本身就证明这条流是活的，所以判空后按当前流重建健康记录，让状态自愈。
   */
  es.addEventListener('ping',()=>{
    if(!currentStream())return;
    const h=sessionLive.health;
    if(!h||h.es!==es)sessionLive.health={es,ready:true,at:Date.now()};
    else h.at=Date.now();
    sessionLiveHealthChanged();
  });
  es.addEventListener('ready',event=>{
    if(!currentStream())return;
    let barrier;try{barrier=JSON.parse(event?.data||'{}').noticeCoverage;}catch{}
    sessionLive.health={es,ready:true,at:Date.now(),coverage:sessionCoverageValid(barrier)};sessionLiveHealthChanged();
    if(ui.rt){ui.rt.conn='';if(typeof rtPatchConn==='function')rtPatchConn();}
    for(const r of sessionLive.targets.values())void sessionLiveReadyResource(r,barrier,currentStream);
    directory();
  });
  const directory=()=>{
    if(!currentStream()||typeof rtLoadDir!=='function')return;
    if(ui.rt){ui.rt.dirDirty=true;ui.rt.dirNotice=(ui.rt.dirNotice||0)+1;}
    if(typeof rtDirectoryVisible==='function'&&!rtDirectoryVisible())return;
    clearTimeout(sessionLive.dirTimer);sessionLive.dirTimer=setTimeout(()=>void rtLoadDir().then(()=>{if(typeof rtRenderListOnly==='function')rtRenderListOnly();}),400);
  };
  for(const name of ['directory','session'])es.addEventListener(name,directory);
  es.addEventListener('profiles',event=>{
    if(!currentStream()||typeof rtLoadProfiles!=='function'||!['rt','rt-new','runtimes','rt-room','rt-room-new','rt-compare'].includes(ui.view)||(ui.view==='rt'&&typeof rtConversationVisible==='function'&&!rtConversationVisible()))return;
    let update={};try{update=JSON.parse(event.data);}catch{}
    void rtLoadProfiles().then(()=>{if(!currentStream())return;if(update.rateLimit&&typeof rtPatchQuotaViews==='function')rtPatchQuotaViews();else if(ui.view==='rt'&&typeof rtRenderSoft==='function')rtRenderSoft();else if(['rt-new','runtimes'].includes(ui.view)&&typeof renderMain==='function')renderMain();});
  });
  es.addEventListener('handoff',event=>{if(typeof liveHandoffNote==='function')liveHandoffNote(event);});
  es.addEventListener('error',()=>{
    if(!currentStream())return;
    const coveredProtocol=sessionLive.health?.coverage;
    // 部署切换的计划内交接：浏览器正按服务端给的间隔自己重连，不在页面上喊「连接中断」。
    const planned=typeof liveHandoffActive==='function'&&liveHandoffActive()&&es.readyState===0;
    // 自建流由这里关闭并重建；共享流交给顶栏 connect() 的退避/回前台重建，不关别人的连接。
    if(!sessionLive.shared){es.close();sessionLive.es=null;}
    sessionLive.health=null;sessionLiveHealthChanged();
    if(ui.rt&&!planned){ui.rt.conn='实时连接中断，状态待核对';if(typeof rtPatchConn==='function')rtPatchConn();}
    // Proven servers catch up once after ready; failed-resource polling still evicts forbidden subscriptions.
    for(const r of sessionLive.targets.values()){const key=sessionLiveKey(r);sessionLive.failed.add(key);if(coveredProtocol)sessionLive.retryAfter.set(key,Date.now()+5000);else sessionLiveSchedule(r);}
    if(!sessionLive.shared)sessionLive.retry=setTimeout(()=>void sessionLiveConnect(),2000);
  });
  return es;
}
function sessionLiveSchedule(resource) {
  if(!sessionLiveHas(resource)||!sessionLiveCurrent(resource)||document.visibilityState==='hidden')return;
  sessionLive.pending.set(sessionLiveKey(resource),resource);
  if(!sessionLive.timer)sessionLive.timer=setTimeout(()=>{sessionLive.timer=null;sessionLiveDrain();},120);
}
function sessionLiveDrain() {
  while(sessionLive.active<2&&sessionLive.pending.size) {
    const available=[...sessionLive.pending].filter(([key])=>!sessionLive.inflight.has(key));
    const entry=available.find(([,r])=>sessionLiveCurrent(r))||available[0];if(!entry)return;
    const [key,r]=entry;sessionLive.pending.delete(key);sessionLive.active++;sessionLive.inflight.add(key);
    void sessionLiveRefresh(r).catch(()=>{}).finally(()=>{if(sessionLiveHas(r)&&sessionLiveCurrent(r)){const state=r.kind==='rt'?ui.rt:ui.room;if(state?.statusConfirmed===false||state?.syncError)sessionLive.failed.add(key);else {sessionLive.failed.delete(key);sessionLive.retryAfter.delete(key);}}
      sessionLive.inflight.delete(key);sessionLive.active--;sessionLiveHealthChanged();sessionLiveDrain();});
  }
}
async function sessionLiveRefresh(resource) {
  if(!sessionLiveHas(resource)||!sessionLiveCurrent(resource)||document.visibilityState==='hidden')return;
  const key=sessionLiveKey(resource), notice=sessionLive.dirty.get(key);
  if(sessionLiveCurrent(resource)) {
    if(resource.kind==='rt'&&typeof rtLoadView==='function') {
      const gen=ui.rt.gen;
      const incremental=ui.rt.deltaEnabled&&!ui.rt.trimmedTail&&ui.rt.events.length<=50;
      await (incremental?rtLoadView(resource.id,gen):Promise.all([rtLoadView(resource.id,gen),rtLoadMessages(resource.id,gen)]));
      if(incremental&&rtReadCurrent(resource.id,gen)&&!ui.rt.deltaEnabled)await rtLoadMessages(resource.id,gen);
      if(rtReadCurrent(resource.id,gen)) {
        if((typeof rtConversationVisible!=='function'||rtConversationVisible()) && ui.rt.statusConfirmed && !ui.rt.syncError && sessionLive.dirty.get(key)===notice)sessionLive.dirty.delete(key);
        rtRenderSoft();
      }
    } else if(resource.kind==='room'&&typeof roomRefresh==='function')await roomRefresh();
    return;
  }
  // Hidden resources retain only their change marker; content catches up on navigation.
}

function sessionLiveStop(resource) {
  clearTimeout(sessionLive.timer);clearTimeout(sessionLive.retry);clearTimeout(sessionLive.dirTimer);
  sessionLive.timer=null;
  sessionLive.epoch++;sessionLive.health=null;sessionLiveHealthChanged();
  if(resource){const key=sessionLiveKey(resource);sessionLive.blocked.add(key);sessionLive.targets.delete(key);sessionLive.pending.delete(key);sessionLive.failed.delete(key);sessionLive.dirty.delete(key);sessionLive.retryAfter.delete(key);if(sessionLive.enabled){
    // 共享流：只把该资源从 watch 里拿掉，不关顶栏连接。
    if(sessionLive.shared)sessionLiveSyncClaim(JSON.stringify([...sessionLive.targets.values()].sort((a,b)=>sessionLiveKey(a).localeCompare(sessionLiveKey(b)))));
    else sessionLive.retry=setTimeout(()=>void sessionLiveConnect(),0);
  }}
  else {
    sessionLive.enabled=false;sessionLive.targets.clear();sessionLive.pending.clear();sessionLive.blocked.clear();sessionLive.failed.clear();sessionLive.dirty.clear();sessionLive.retryAfter.clear();
    if(sessionLive.shared){sessionLive.shared=false;sessionLive.key='';sessionLive.es=null;if(typeof window.piLiveRelease==='function')window.piLiveRelease(sessionLiveAttach);}
    else {sessionLive.es?.close();sessionLive.es=null;sessionLive.key='';}
  }
}
/* 离线恢复：app.js 的连通性探测成功后补一次订阅资源的增量同步（pending 去重，不重复下载）。 */
if(typeof window!=='undefined'&&window.addEventListener)window.addEventListener('pi-network-ready',()=>{
  if(document.visibilityState==='hidden'||!sessionLive.enabled)return;
  for(const r of sessionLive.targets.values())sessionLiveSchedule(r);
});
function sessionLiveResume(){
  if(document.visibilityState!=='visible'||!sessionLive.enabled)return;
  for(const r of sessionLive.targets.values())sessionLiveSchedule(r);
  const targets=sessionLiveResources();
  const key=JSON.stringify([...targets.values()].sort((a,b)=>sessionLiveKey(a).localeCompare(sessionLiveKey(b))));
  // 共享流：只核对订阅目标；连接健康与重连（CLOSED / 心跳超时）由顶栏 connect() 负责。
  if(sessionLive.shared){
    sessionLive.targets=targets;
    sessionLiveSyncClaim(key);
    return;
  }
  // 回前台只重建真正不可用或订阅目标变了的流；健康流继续靠增量同步补上，不重复建 SSE。
  const dead=!sessionLive.es||sessionLive.es.readyState===2;
  const stale=!!sessionLive.health?.ready&&Date.now()-sessionLive.health.at>45000;
  if(dead||stale||sessionLive.key!==key)void sessionLiveConnect(true);
}
document.addEventListener('visibilitychange',sessionLiveResume);
if(typeof window!=='undefined'&&typeof window.addEventListener==='function')window.addEventListener('pi-native-resume',sessionLiveResume);
