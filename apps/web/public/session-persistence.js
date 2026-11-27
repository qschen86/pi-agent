"use strict";
/* Display-only database. Every restore separately checks current server authorization. */
const sessionDisk = { enabled: false, partition: null, epoch: 0, db: null, opening: null, writes: new Map(), timers: new Map(), blocked: new Set() };
const SESSION_DISK_PREF = 'pi-agent:session-display:enabled';
// Like a chat app, saved sessions stay on this device for a week; the server still decides what is current.
const SESSION_DISK_MAX_AGE = 7 * 86400000, SESSION_DISK_MAX_RECORDS = 30, SESSION_DISK_MAX_BYTES = 50 * 1024 * 1024;
// Only current-page, server-authorized display snapshots; never persisted permission grants.
const sessionWarmDisplays = new Map();
let sessionDirectoryAccess = null;
function sessionDirectoryAllows(resource) {
  const access=sessionDirectoryAccess;
  return !!(access && sessionDisk.enabled && access.epoch===sessionDisk.epoch && access.partition===sessionDisk.partition && Date.now()-access.at<60000 && access.resources.has(JSON.stringify([resource.kind,resource.id])));
}
// Warm displays are held in memory for the sessions the directory just named. The ceiling follows the
// disk layer (30 records / 50 MiB) so a start that already has a body on disk can paint it before any read.
const SESSION_WARM_MAX_RECORDS = 30, SESSION_WARM_MAX_BYTES = 40 * 1024 * 1024;
async function sessionWarmDirectory(directory,current,options={}) {
  sessionWarmDisplays.clear();sessionDirectoryAccess=null;
  const access=directory?.cacheAccess;
  if(!sessionDisk.enabled || access?.schema!==1 || !access.partition || !Array.isArray(access.resources) || !current())return;
  const provisional=options.provisional===true;
  // A first foreground restore owns the initial login binding. Warming must not
  // advance its storage epoch before bootstrap can confirm that same partition.
  const state=ui.view==='rt'?ui.rt:ui.view==='rt-room'?ui.room:null;
  const flight=state?.diskRestoreFlight,started=sessionDisk.epoch;
  if(!provisional && !sessionDisk.partition && flight && flight.epoch===started){
    await flight.promise;
    if(!current() || !sessionDisk.enabled || (sessionDisk.epoch!==started && sessionDisk.epoch!==flight.authorizedEpoch) || (sessionDisk.partition && sessionDisk.partition!==access.partition))return;
  }
  if(provisional){
    // A snapshot read from disk only says what this device was allowed earlier. It may
    // adopt the partition this device already has remembered, but it must never move the
    // storage epoch an in-flight restore compares against (that silently downgraded
    // cursor resumes to full reads, see v3.50). A different login waits for the server.
    const remembered=typeof localFirstPartition==='function'?localFirstPartition():null;
    if(!sessionDisk.partition && remembered && remembered===access.partition)sessionDisk.partition=remembered;
    if(sessionDisk.partition!==access.partition)return;
  } else sessionPersistenceAuthorize(access.partition);
  const epoch=sessionDisk.epoch,partition=sessionDisk.partition,at=Date.now();
  const permitted=new Set(access.resources.map(r=>JSON.stringify([r.kind,r.id])));
  const grant={epoch,partition,at,resources:permitted};sessionDirectoryAccess=grant;
  // Let the directory paint before any database work. A click can read just its own record.
  await new Promise(resolve=>setTimeout(resolve,0));
  const db=await sessionDiskOpen();if(!db||!current()||epoch!==sessionDisk.epoch||sessionDirectoryAccess!==grant)return;
  const records=await sessionDiskTransaction(db,'readonly',(tx,done)=>{
    const get=tx.objectStore('records').getAll();get.onsuccess=()=>done(get.result);
  });
  let bytes=0,count=0;
  for(const record of records||[]){
    if(!current()||epoch!==sessionDisk.epoch||sessionDirectoryAccess!==grant)return;
    const resource=record.resource;
    if(!resource||!permitted.has(JSON.stringify([resource.kind,resource.id]))||!sessionDiskActive(epoch,partition,record.key)||!sessionDiskRecordValid(record,resource,partition))continue;
    bytes+=record.bytes;if(bytes>SESSION_WARM_MAX_BYTES||count>=SESSION_WARM_MAX_RECORDS)break;
    sessionWarmDisplays.set(JSON.stringify([resource.kind,resource.id]),{display:sessionDisplayProjection(resource,record.display),epoch,partition,at});count++;
  }
}
function sessionUseWarmDisplay(resource,state) {
  if(!sessionDirectoryAllows(resource))return false;
  state.diskAuthorized=true;state.diskAuthorizationEpoch=sessionDisk.epoch;
  const key=JSON.stringify([resource.kind,resource.id]),hit=sessionWarmDisplays.get(key);
  if(!hit||hit.epoch!==sessionDisk.epoch||hit.partition!==sessionDisk.partition||Date.now()-hit.at>=60000)return false;
  sessionWarmDisplays.delete(key);
  sessionApplyDiskDisplay(resource,state,hit.display);return true;
}
async function sessionRestorePreparedDisplay(resource,generation) {
  if(!sessionDirectoryAllows(resource))return false;
  const epoch=sessionDisk.epoch,hit=await sessionPersistenceRead(resource);
  const state=resource.kind==='rt'?ui.rt:ui.room;
  const hasBody=resource.kind==='rt'?state.messagesFor===resource.id||state.events.length>0:!!state.view;
  if(!hit||epoch!==sessionDisk.epoch||!sessionDirectoryAllows(resource)||!sessionDiskCurrent(resource,generation)||hasBody||state.diskDisplay)return false;
  sessionApplyDiskDisplay(resource,state,hit.display);renderMain();return true;
}
function sessionApplyDiskDisplay(resource,state,display) {
  window.piOpenTiming?.mark('body-cache');
  state.diskDisplay=display;state.reading=display.reading;state.atBottom=display.reading?.atBottom??true;state.statusConfirmed=false;
  if(resource.kind==='rt'){state.openFolds={...display.expanded};state.events=display.items;state.messagesFor=resource.id;state.hasMoreBefore=display.window.hasMoreBefore;}
  else state.expanded={...display.expanded};
}
try { const preference = localStorage.getItem(SESSION_DISK_PREF); sessionDisk.enabled = preference === null || preference === 'true'; } catch {}
let sessionDiskLastTouch = 0;
function sessionDiskTouch() { return sessionDiskLastTouch = Math.max(Date.now(),sessionDiskLastTouch+1); }
const SESSION_DISK_REVOKED = 'pi-agent:session-display:revoked';
let sessionDiskRevoked = {};
try { const saved=JSON.parse(localStorage.getItem(SESSION_DISK_REVOKED)||'{}'); if(saved&&typeof saved==='object'&&!Array.isArray(saved))sessionDiskRevoked=saved; } catch {}
function sessionDiskCutoff(resource,partition) { return Math.max(Number(sessionDiskRevoked['*'])||0,Number(sessionDiskRevoked[JSON.stringify([partition])])||0,Number(sessionDiskRevoked[sessionDiskKey(resource,partition)])||0); }
function sessionDiskRevoke(kind,resource,partition,at=Date.now()) {
  const key=kind==='clear'?'*':resource?sessionDiskKey(resource,partition):JSON.stringify([partition]);
  sessionDiskRevoked[key]=Math.max(Number(sessionDiskRevoked[key])||0,at);
  for(const k of Object.keys(sessionDiskRevoked))if(Date.now()-sessionDiskRevoked[k]>86400000)delete sessionDiskRevoked[k];
  if(Object.keys(sessionDiskRevoked).length>32)sessionDiskRevoked={'*':at};
  try { localStorage.setItem(SESSION_DISK_REVOKED,JSON.stringify(sessionDiskRevoked)); } catch {}
}
function sessionDisplayFields(value, fields) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const key of fields.split(' ')) if (['string','number','boolean'].includes(typeof value[key]) && (typeof value[key] !== 'number' || Number.isFinite(value[key]))) out[key] = value[key];
  return out;
}
// The resume record contains a complete display window and its matching cursor, never control state.
function sessionSyncDiskProjection(resource, value) {
  if (!value || value.resource?.kind !== resource.kind || value.resource?.id !== resource.id || typeof value.epoch !== 'string' || typeof value.cursor !== 'string' || value.cursor.length > 4096) return null;
  const limit = value.queryWindow?.limit;
  if (!(resource.kind === 'rt' ? [50,100].includes(limit) : limit === 50) || Object.keys(value.queryWindow).length !== 1 || !Array.isArray(value.items) || value.items.length > limit) return null;
  const ids = new Set(), items = [];
  for (const item of value.items) {
    if (typeof item.id !== 'string' || ids.has(item.id) || !Number.isFinite(item.seq) || !Number.isSafeInteger(item.revision) || item.revision < 0 || !item.value) return null;
    ids.add(item.id);
    items.push({id:item.id,seq:item.seq,revision:item.revision,value:sessionDisplayProjection(resource,{items:[item.value]}).items[0]});
  }
  const window = sessionDisplayFields(value.window,'total firstSeq lastSeq hasMoreBefore hasMore coverage');
  if (Array.isArray(value.window?.notes)) window.notes = value.window.notes.filter(x => typeof x === 'string');
  // Version the checksum too: old baselines omitted check metadata but retained a current cursor.
  const result = {resource:{kind:resource.kind,id:resource.id},epoch:value.epoch,cursor:value.cursor,queryWindow:{limit},items,window,...(resource.kind === 'rt' ? {displayVersion:2} : {})};
  // Detect truncated/mixed/damaged baseline records. This is integrity checking, not authorization.
  let hash = 2166136261;
  for (const char of JSON.stringify(result)) hash = Math.imul(hash ^ char.charCodeAt(0),16777619) >>> 0;
  const checksum = String(hash);
  if (value.checksum !== undefined && value.checksum !== checksum) return null;
  return {...result,checksum};
}
function sessionDisplayProjection(resource, value) {
  const rt = resource.kind === 'rt';
  const items = (Array.isArray(value.items) ? value.items : []).slice(-(rt ? 100 : 50)).map(item => {
    const out = sessionDisplayFields(item, rt ? 'key seq kind role text partial status turnNo subagent occurredAt recordedAt source parserVersion availability redactions' : 'seq kind author text createdAt memberId replyTo');
    if (rt) {
      if (item.truncated) out.truncated = sessionDisplayFields(item.truncated, 'originalChars');
      if (item.tool) out.tool = sessionDisplayFields(item.tool, 'name input output status exitCode');
      if (item.enforcement) out.enforcement = { ...sessionDisplayFields(item.enforcement, 'phase attempt'), rules: (Array.isArray(item.enforcement.rules) ? item.enforcement.rules : []).map(rule => sessionDisplayFields(rule, 'topicId ruleId topic statement title note problem fix')) };
      if (item.backgroundTask) out.backgroundTask = sessionDisplayFields(item.backgroundTask, 'id status startedAt endedAt description');
      if (item.image) out.image = sessionDisplayFields(item.image, 'path status');
      if (Array.isArray(item.attachments)) out.attachments = item.attachments.map(x => sessionDisplayFields(x, 'attachmentId originalName mimeType byteSize width height sha256 expiresAt'));
    } else {
      out.quotes = (Array.isArray(item.quotes) ? item.quotes : []).map(x => ({ ...sessionDisplayFields(x, 'seq text author'), ...(x.span ? {span: sessionDisplayFields(x.span,'start end')} : {}) }));
      out.mentions = (Array.isArray(item.mentions) ? item.mentions : []).filter(x => typeof x === 'string');
      out.deliveries = (Array.isArray(item.deliveries) ? item.deliveries : []).map(x => sessionDisplayFields(x,'memberId status error resultSeq'));
      if (item.source) out.source = sessionDisplayFields(item.source, 'memberId alias runtimeKind model platformSessionId turnNo seqStart seqEnd');
    }
    return out;
  });
  const expanded = {};
  for (const [key, flag] of Object.entries(value.expanded || {})) if (typeof flag === 'boolean' && key.length < 256) expanded[key] = flag;
  return { items, summary: sessionDisplayFields(value.summary,'id title runtimeKind readOnly'),
    window: { ...sessionDisplayFields(value.window, 'total firstSeq lastSeq hasMoreBefore hasMore coverage trimmedTail'), scope:'latest' },
    reading: sessionDisplayFields(value.reading, 'seq offset top atBottom'), expanded,
    ...(value.sync ? {sync:sessionSyncDiskProjection(resource,value.sync)} : {}) };
}
function sessionDiskKey(resource, partition = sessionDisk.partition) { return JSON.stringify([partition, resource.kind, resource.id]); }
function sessionDiskOpen() {
  if (sessionDisk.db) return Promise.resolve(sessionDisk.db);
  if (sessionDisk.opening) return sessionDisk.opening;
  sessionDisk.opening = new Promise(resolve => {
    let settled = false, request;
    const finish = db => { if (settled) { db?.close(); return; } settled = true; clearTimeout(timer); resolve(db); };
    const timer = setTimeout(() => finish(null), 1000);
    try {
      request = indexedDB.open('pi-agent-session-display', 1);
      request.onupgradeneeded = () => { const db = request.result; db.createObjectStore('records', {keyPath:'key'}); db.createObjectStore('invalidations'); };
      request.onblocked = () => finish(null);
      request.onerror = () => finish(null);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); if (sessionDisk.db === db) sessionDisk.db = null; };
        if (!settled) sessionDisk.db = db;
        finish(db);
      };
    } catch { finish(null); }
  }).finally(() => { sessionDisk.opening = null; });
  return sessionDisk.opening;
}
function sessionDiskTransaction(db, mode, work) {
  return new Promise(resolve => {
    let tx, result = null;
    try {
      tx = db.transaction(['records','invalidations'], mode);
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => resolve(null);
      work(tx, value => { result = value; });
    } catch { resolve(null); }
  });
}
function sessionDiskActive(epoch, partition, key) { return sessionDisk.enabled && partition && sessionDisk.epoch === epoch && sessionDisk.partition === partition && !sessionDisk.blocked.has(key); }
async function sessionDiskStamp(db) {
  return sessionDiskTransaction(db,'readonly',(tx,done) => { const r = tx.objectStore('invalidations').get('generation'); r.onsuccess = () => done(r.result || 0); });
}
function sessionDiskSignal(kind, resource, partition) {
  const event = {kind,resource,partition,at:Date.now(),nonce:Math.random()};
  try { sessionDiskChannel?.postMessage(event); localStorage.setItem('pi-agent:session-display:invalidate',JSON.stringify(event)); } catch {}
}
function sessionDiskReceive(event) {
  if (!event || !['clear','partition','resource'].includes(event.kind)) return;
  sessionDiskRevoke(event.kind,event.resource,event.partition,event.at);
  if (event.kind === 'clear' || event.partition === sessionDisk.partition) {
    sessionDisk.epoch++;
    if (event.kind === 'partition') { sessionDisk.partition = null; if (typeof sessionCachesClear === 'function') sessionCachesClear(true); }
    if (event.kind === 'resource' && event.resource) {
      sessionDisk.blocked.add(sessionDiskKey(event.resource));
      // Revoke both live and saved displays; skip sending this same invalidation back.
      if (typeof sessionResourceClear === 'function') sessionResourceClear(event.resource);
    }
  }
}
let sessionDiskChannel;
try { sessionDiskChannel = new BroadcastChannel('pi-agent-session-display'); sessionDiskChannel.onmessage = e => sessionDiskReceive(e.data); } catch {}
window.addEventListener('storage', e => {
  if (e.key === SESSION_DISK_PREF) { sessionDisk.enabled = e.newValue === null || e.newValue === 'true'; sessionDisk.epoch++; }
  if (e.key === 'pi-agent:session-display:invalidate') { try { sessionDiskReceive(JSON.parse(e.newValue)); } catch {} }
});
function sessionPersistenceAuthorize(partition) {
  const next = typeof partition === 'string' && partition ? partition : null;
  if (sessionDisk.partition !== next) { sessionDisk.epoch++; sessionDisk.partition = next; sessionDisk.blocked.clear(); }
  if (typeof localFirstRememberPartition === 'function') localFirstRememberPartition(next);
}
async function sessionPersistenceEnable(enabled) {
  sessionDisk.enabled = !!enabled; sessionDisk.epoch++;
  try { localStorage.setItem(SESSION_DISK_PREF, String(!!enabled)); } catch { sessionDisk.enabled = false; }
  if (!sessionDisk.enabled) await sessionPersistenceClear();
}
// Re-fetch old runtime snapshots rather than restoring notices whose enforcement fields were lost.
function sessionDiskRecordValid(r,resource,partition) {
  return r.schema===1 && (resource.kind!=='rt' || r.displayVersion===2) && r.partition===partition && r.resource?.kind===resource.kind && r.resource?.id===resource.id && Number.isFinite(r.confirmedAt) && r.confirmedAt>sessionDiskCutoff(resource,partition) && Date.now()-r.confirmedAt<SESSION_DISK_MAX_AGE && Array.isArray(r.display?.items) && Number.isFinite(r.bytes) && r.bytes<=10*1024*1024;
}
// Untrusted candidate only: reading it neither authorizes nor displays anything.
async function sessionPersistenceCandidate(resource) {
  const epoch=sessionDisk.epoch;
  if(!sessionDisk.enabled)return null;
  const db=await sessionDiskOpen();if(!db||epoch!==sessionDisk.epoch||!sessionDisk.enabled)return null;
  const records=await sessionDiskTransaction(db,'readonly',(tx,done)=>{
    const request=tx.objectStore('records').getAll();request.onsuccess=()=>done(request.result);
  });
  if(epoch!==sessionDisk.epoch||!sessionDisk.enabled)return null;
  const record=(records||[]).filter(r=>typeof r.partition==='string'&&r.partition&&r.key===sessionDiskKey(resource,r.partition)&&!sessionDisk.blocked.has(r.key)&&sessionDiskRecordValid(r,resource,r.partition)).sort((a,b)=>b.confirmedAt-a.confirmedAt)[0];
  return record?{partition:record.partition,display:sessionDisplayProjection(resource,record.display)}:null;
}
async function sessionPersistenceRead(resource) {
  const epoch = sessionDisk.epoch, partition = sessionDisk.partition, key = sessionDiskKey(resource);
  if (!sessionDiskActive(epoch,partition,key)) return null;
  const db = await sessionDiskOpen(); if (!db || !sessionDiskActive(epoch,partition,key)) return null;
  const record = await sessionDiskTransaction(db,'readwrite',(tx,done) => {
    const store = tx.objectStore('records'), get = store.get(key);
    get.onsuccess = () => {
      const r = get.result;
      if (!r) return;
      if (!sessionDiskRecordValid(r,resource,partition)) { store.delete(key); return; }
      // Re-project disk data as well; damaged/older records cannot smuggle control fields.
      r.display = sessionDisplayProjection(resource,r.display); r.usedAt = sessionDiskTouch(); store.put(r); done(r);
    };
  });
  return sessionDiskActive(epoch,partition,key) ? record : null;
}
function sessionPersistenceWrite(resource, value) {
  const key=sessionDiskKey(resource),epoch=sessionDisk.epoch;
  if(!sessionDiskActive(epoch,sessionDisk.partition,key))return Promise.resolve();
  let display;try{display=sessionDisplayProjection(resource,value);}catch{return Promise.resolve();}
  // One executing write and only the newest pending projection per resource.
  const old=sessionDisk.writes.get(key);
  if(old){old.next={resource,display,epoch};return old.promise;}
  const entry={next:{resource,display,epoch},promise:null};
  entry.promise=Promise.resolve().then(async()=>{
    while(entry.next){const next=entry.next;entry.next=null;if(next.epoch===sessionDisk.epoch)await sessionDiskWriteRecord(next.resource,next.display);}
  }).finally(()=>{if(sessionDisk.writes.get(key)===entry)sessionDisk.writes.delete(key);});
  sessionDisk.writes.set(key,entry);return entry.promise;
}
async function sessionDiskWriteRecord(resource, value) {
  const epoch = sessionDisk.epoch, partition = sessionDisk.partition, key = sessionDiskKey(resource);
  if (!sessionDiskActive(epoch,partition,key)) return;
  // Capture the database generation before waiting behind any older writer.
  const db = await sessionDiskOpen(); if (!db || !sessionDiskActive(epoch,partition,key)) return;
  const stamp = await sessionDiskStamp(db);
  if (!sessionDiskActive(epoch,partition,key)) return;
  try {
    if (!sessionDiskActive(epoch,partition,key)) return;
    let record;
    try {
      record = {key,schema:1,...(resource.kind==='rt'?{displayVersion:2}:{}),partition,resource:{kind:resource.kind,id:resource.id},confirmedAt:Math.max(Date.now(),sessionDiskCutoff(resource,partition)+1),usedAt:sessionDiskTouch(),display:sessionDisplayProjection(resource,value)};
      record.bytes = new TextEncoder().encode(JSON.stringify(record)).byteLength;
      if (record.bytes > 10*1024*1024) return;
    } catch { return; }
    await sessionDiskTransaction(db,'readwrite',tx => {
      const versions = tx.objectStore('invalidations'), get = versions.get('generation');
      get.onsuccess = () => {
        if ((get.result || 0) !== stamp || !sessionDiskActive(epoch,partition,key)) { tx.abort(); return; }
        const store = tx.objectStore('records'); store.put(record);
        const all = store.getAll();
        all.onsuccess = () => {
          let entries = all.result.sort((a,b) => b.usedAt-a.usedAt), bytes = 0;
          entries.forEach((r,i) => { bytes += r.bytes || 0; if (i >= SESSION_DISK_MAX_RECORDS || bytes > SESSION_DISK_MAX_BYTES || Date.now()-r.confirmedAt >= SESSION_DISK_MAX_AGE) store.delete(r.key); });
        };
      };
    });
  } catch {}
}
async function sessionDiskDelete(kind, resource) {
  const partition = sessionDisk.partition;
  sessionDiskRevoke(kind,resource,partition);
  sessionDisk.epoch++;
  if (resource) sessionDisk.blocked.add(sessionDiskKey(resource));
  if (kind === 'partition') sessionDisk.partition = null;
  if ((kind === 'clear' || kind === 'partition') && typeof localFirstClear === 'function') void localFirstClear();
  for (const timer of sessionDisk.timers.values()) clearTimeout(timer); sessionDisk.timers.clear();
  sessionDiskSignal(kind,resource,partition);
  const db = await sessionDiskOpen(); if (!db) return;
  await sessionDiskTransaction(db,'readwrite',tx => {
    const versions = tx.objectStore('invalidations'); versions.put(Date.now()+Math.random(),'generation');
    const store = tx.objectStore('records');
    if (kind === 'clear') { store.clear(); return; }
    const all = store.getAll(); all.onsuccess = () => { for (const r of all.result) if (r.partition === partition && (!resource || (r.resource?.kind === resource.kind && r.resource?.id === resource.id))) store.delete(r.key); };
  });
}
function sessionPersistenceInvalidate(resource) { return sessionDiskDelete(resource ? 'resource' : 'partition',resource); }
function sessionPersistenceClear() { return sessionDiskDelete('clear'); }
function sessionPersistenceReading(resource, reading, expanded) {
  const key = sessionDiskKey(resource), epoch = sessionDisk.epoch, partition = sessionDisk.partition;
  clearTimeout(sessionDisk.timers.get(key));
  const save = async () => {
    sessionDisk.timers.delete(key);
    if (!sessionDiskActive(epoch,partition,key)) return;
    const db = await sessionDiskOpen(); if (!db) return;
    await sessionDiskTransaction(db,'readwrite',tx => {
      const store = tx.objectStore('records'), get = store.get(key);
      get.onsuccess = () => {
        const r = get.result; if (!r || !sessionDiskActive(epoch,partition,key)) return;
        r.display.reading = sessionDisplayFields(reading,'seq offset top atBottom');
        r.display.expanded = sessionDisplayProjection(resource,{expanded}).expanded;
        r.usedAt = sessionDiskTouch(); r.bytes = new TextEncoder().encode(JSON.stringify(r)).byteLength;
        if (r.bytes <= 10*1024*1024) store.put(r);
      };
    });
  };
  sessionDisk.timers.set(key,setTimeout(() => void save(),500));
}
function sessionDiskCurrent(resource, generation) {
  return resource.kind === 'rt' ? rtReadCurrent(resource.id,generation) : roomCurrent(resource.id,generation);
}
async function sessionBootstrap(resource, current) {
  const path=(resource.kind==='rt'?'/api/runtime-sessions/':'/api/rooms/')+encodeURIComponent(resource.id);
  let access,legacy=false;
  try { access=await api(path+'/bootstrap'); }
  catch(e) {
    // Only an absent endpoint on an older server permits the legacy fallback.
    // A denied or missing resource must not trigger a second authorization path.
    if(!current())return null;
    if(e.status!==404 || e.code)throw e;
    legacy=true;
    const auth=await api('/api/auth/sessions');
    if(!current())return null;
    if(!auth.current)return {schema:1,resource,partition:null};
    access=await api(path+'/cache-access');
    if(access.partition!==auth.current)return null;
  }
  if(!current() || access?.schema!==1 || access.resource?.kind!==resource.kind || access.resource?.id!==resource.id || !(access.partition===null || typeof access.partition==='string') || access.display?.allowed===false)return null;
  if(!legacy && (access.display?.allowed!==true || access.control?.requiresLatestState!==true || access.incremental?.protocolVersion!==1 || typeof access.incremental?.supported!=='boolean'))return null;
  return access;
}
function sessionRestoreDisplay(resource, generation) {
  if (!sessionDisk.enabled || !sessionDiskCurrent(resource,generation)) return Promise.resolve(false);
  const restoring=resource.kind==='rt'?ui.rt:ui.room,epoch=sessionDisk.epoch,old=restoring.diskRestoreFlight;
  if(old && old.id===resource.id && old.generation===generation && (old.epoch===epoch || old.authorizedEpoch===epoch))return old.promise;
  const flight={id:resource.id,generation,epoch,promise:null,authorizedEpoch:null};
  restoring.diskRestoreFlight=flight;restoring.diskRestorePending=true;
  flight.promise=sessionRestoreDisplayOnce(resource,generation,flight).finally(()=>{
    if(restoring.diskRestoreFlight===flight){restoring.diskRestoreFlight=null;restoring.diskRestorePending=false;}
  });
  return flight.promise;
}
/*
 * Local-first: show the saved body at once under the login partition this device last confirmed, and
 * let the bootstrap below verify it. A different partition, a denial (401/403/404/410) or a revoked
 * resource takes the display away again; an unreachable server simply keeps reading the saved copy.
 */
async function sessionOptimisticDisplay(resource, generation, flight) {
  const last = typeof localFirstPartition === 'function' ? localFirstPartition() : null;
  if (!sessionDisk.enabled || (!sessionDisk.partition && !last) || !sessionDiskCurrent(resource, generation)) return null;
  // Adopting the remembered partition must not advance the storage epoch: in-flight restores compare against it,
  // and a bump would silently turn the incremental resume into a full read. A different partition from the
  // server still bumps it through the normal authorization below.
  if (!sessionDisk.partition) { sessionDisk.partition = last; sessionDisk.blocked.clear(); }
  const epoch = sessionDisk.epoch, partition = sessionDisk.partition;
  const hit = await sessionPersistenceRead(resource);
  const state = resource.kind === 'rt' ? ui.rt : ui.room;
  const hasBody = resource.kind === 'rt' ? state.messagesFor === resource.id || state.events.length > 0 : !!state.view;
  if (!hit || !sessionDiskCurrent(resource, generation) || epoch !== sessionDisk.epoch || hasBody || state.diskDisplay) return null;
  sessionApplyDiskDisplay(resource, state, hit.display);
  state.optimisticDisplay = true;
  renderMain();
  return { partition, epoch };
}
function sessionRevertOptimistic(resource, state) {
  if (!state.optimisticDisplay || !state.diskDisplay) return;
  state.optimisticDisplay = false; state.diskDisplay = null; state.diskAuthorized = false;
  if (resource.kind === 'rt') { state.events = []; state.messagesFor = null; } else state.expanded = {};
  renderMain();
}
async function sessionRestoreDisplayOnce(resource, generation, flight) {
  let epoch=flight.epoch,optimistic=null;
  const state = resource.kind === 'rt' ? ui.rt : ui.room;
  try {
    // The verification request starts at once; the saved body is read alongside it, never before it.
    const bootstrapping = sessionBootstrap(resource,()=>sessionDiskCurrent(resource,generation)&&sessionDisk.enabled&&sessionDisk.epoch===epoch);
    bootstrapping.catch(()=>{});
    const showing = sessionOptimisticDisplay(resource,generation,flight);
    epoch=flight.epoch;
    optimistic = await showing;
    const access = await bootstrapping;
    if (!access) { if (optimistic && sessionDiskCurrent(resource,generation) && sessionDisk.enabled) sessionRevertOptimistic(resource,state); return false; }
    sessionPersistenceAuthorize(access.partition);
    if (optimistic && sessionDisk.partition !== optimistic.partition) sessionRevertOptimistic(resource,state);
    state.optimisticDisplay = false;
    if (!access.partition) return false;
    const life = sessionDisk.epoch;
    flight.authorizedEpoch=life;
    state.diskAuthorized = true;
    state.diskAuthorizationEpoch = life;
    if (window.PI_AGENT_PERF) performance.mark('v37-disk-authorized');
    const hit = await sessionPersistenceRead(resource);
    const hasBody = resource.kind === 'room' ? !!state.view : state.messagesFor === resource.id || state.events.length > 0;
    if (!sessionDiskCurrent(resource,generation) || life !== sessionDisk.epoch || hasBody || !hit) { sessionPersistCurrent(resource); return false; }
    sessionApplyDiskDisplay(resource,state,hit.display);
    if (window.PI_AGENT_PERF) performance.mark('v37-disk-before-render');
    renderMain(); return true;
  } catch (e) {
    if (!sessionDiskCurrent(resource,generation)) return false;
    if ([401,403,404,410].includes(e.status)) {
      await sessionPersistenceInvalidate(e.status === 401 ? undefined : resource);
      if (resource.kind === 'rt') rtReadFailure(resource.id,generation,e);
      else { ui.room.diskDisplay = null; ui.room.view = null; ui.room.statusConfirmed = false; ui.room.error = e.message; roomStop(); renderMain(); }
    }
    return false;
  }
}
function sessionPersistCurrent(resource) {
  const state = resource.kind === 'rt' ? ui.rt : ui.room;
  if (!state.diskAuthorized || !state.statusConfirmed || !state.view || state.syncError || state.trimmedTail) return;
  const rt = resource.kind === 'rt';
  if (rt && state.messagesFor !== resource.id) return;
  const v = state.view, s = rt ? v.session : v.room;
  const queryWindow={limit:50};
  const sync=typeof sessionDeltas!=='undefined'?sessionDeltas.views.get(sessionSyncKey(resource,queryWindow)):null;
  void sessionPersistenceWrite(resource,{items:rt ? state.events : v.messages,summary:{id:resource.id,title:s.title || s.summary || resource.id,runtimeKind:s.runtimeKind,readOnly:!!v.readOnly},window:rt ? {total:state.total,hasMoreBefore:state.hasMoreBefore,coverage:state.coverage} : {total:v.total,hasMore:v.hasMore},reading:state.reading || {atBottom:state.atBottom},expanded:rt ? state.openFolds : state.expanded,...(sync?{sync:{...sync,queryWindow}}:{})});
}
function sessionDiskPanel(resource, display) {
  const state = resource.kind === 'rt' ? ui.rt : ui.room;
  const box = h('div',{class:'rt-transcript'+(resource.kind === 'room'?' room-timeline':''),role:'log',tabindex:'0',onscroll:ev=>{state.atBottom=ev.target.scrollHeight-ev.target.scrollTop-ev.target.clientHeight<40;state.reading=sessionReadingCapture(ev.target,state.atBottom);sessionPersistenceReading(resource,state.reading,display.expanded);}},display.items.map(item=>resource.kind==='rt' ? rtEventRow(item,resource.id) : sessionDiskRoomRow(item,display)));
  const missing = display.reading?.seq != null && !display.items.some(x=>x.seq === display.reading.seq);
  const summary = display.summary ? {title:display.summary.title,runtimeKind:display.summary.runtimeKind} : null;
  // The body is already on screen, so this is a real header with a real title and a「本机」chip —
  // not the 「读取中」 skeleton, which made a cached open look like a network wait.
  const head = resource.kind === 'rt' && typeof rtHeadLoading === 'function'
    ? rtHeadLoading('session', summary, {cached:true})
    : h('header',{class:'rt-head room-head'},
      h('div',{class:'rt-title-row'},
        h('div',{class:'rt-title-main'},h('h1',{class:'rt-title'},h('span',{class:'rt-title-text'},display.summary?.title || resource.id))),
        h('div',{class:'rt-title-tags','aria-hidden':'true'},badge('本机',''))));
  // Verification is a quiet note that only appears if the check actually takes a moment;
  // it never takes the place of the content and never spins.
  const verify = state.syncError
    ? h('p',{class:'field-error',role:'alert'},'同步失败，已保留本机内容。',state.syncError,h('button',{type:'button',class:'btn small',onclick:()=>refresh({main:true,force:true,global:false})},'重试'))
    : h('p',{class:'rt-verify',role:'status',hidden:true});
  if(!state.syncError)setTimeout(()=>{if(verify.isConnected&&!state.syncError){verify.textContent='正在核对最新状态…';verify.hidden=false;}},600);
  queueMicrotask(()=>{if(box.isConnected)sessionReadingWatch(box,display.reading);});
  return h('section',{class:'rt-center','aria-label':'上次保存的会话内容'},head,missing ? h('p',{role:'status',class:'muted'},'阅读位置未完全恢复，已定位到保留内容附近。') : null,box,verify,
    // 核对期间也先把输入区摆上：输入框先出现，最新状态随后接入
    resource.kind === 'rt' && typeof rtComposerLoading === 'function' ? rtComposerLoading() : null);
}
function sessionPersistenceSettings() {
  // 开关行与设置页其它开关同构：左边标题 + 右侧统一开关，说明放在下面。
  return h('section',{class:'nav-settings-cache'},
    h('div',{class:'settings-switch-row'},h('strong',{},'保存本机会话正文'),h('input',{type:'checkbox',role:'switch',class:'settings-switch','aria-label':'保存本机会话正文',checked:sessionDisk.enabled,onchange:async ev=>{await sessionPersistenceEnable(ev.target.checked);ev.target.checked=sessionDisk.enabled;}})),
    h('p',{class:'muted small'},'会话列表和最近会话正文保存在本机，打开即显示，再在后台核对更新；正文最多保存 7 天，退出登录或登录失效会立即清除。本机匿名入口不保存。'),
    h('button',{type:'button',class:'btn small',onclick:async ev=>{await sessionPersistenceClear();ev.target.textContent='已清除正文缓存';}},'清除本机正文缓存'),
    h('p',{class:'muted small'},'只清除此站点保存的会话列表、正文和阅读快照，保留输入草稿及服务器历史。'),
    sessionOpenTimingLine());
}
function sessionOpenTimingLine() {
  const s = window.piOpenTiming?.summary?.(), ms = v => v == null ? '–' : `${v} ms`;
  if (!s || !s.cold.count) return null;
  return h('p',{class:'muted small','data-open-timing':'1'},`最近打开耗时（中位数，共 ${s.cold.count} 次）：列表 本机 ${ms(s.cold['dir-cache'])} / 网络 ${ms(s.cold['dir-net'])}；正文 本机 ${ms(s.cold['body-cache'])} / 网络 ${ms(s.cold['body-net'])}`);
}

function sessionDiskRoomRow(item,display) {
  const body=h('div',{class:'room-text'},typeof rtMarkdown==='function'?rtMarkdown(item.text||''):item.text||'');
  const long=(item.text||'').length>1200;
  const content=long?h('details',{open:!!ui.room.expanded[item.seq],ontoggle:ev=>{ui.room.expanded[item.seq]=ev.currentTarget.open;sessionPersistenceReading({kind:'room',id:ui.room.id},ui.room.reading,ui.room.expanded);}},h('summary',{},'展开保存的回复'),body):body;
  return h('div',{'data-room-seq':String(item.seq),class:'room-row'},h('strong',{},item.author||item.source?.alias||''),
    (item.quotes||[]).map(q=>h('button',{type:'button',class:'room-quote',onclick:()=>roomJump(q.seq)},q.text||`#${q.seq}`)),content,
    (item.deliveries||[]).map(d=>h('span',{class:'room-receipt'},`${d.memberId}: ${d.status}${d.error?' · '+d.error:''}`)),
    item.source?.platformSessionId?h('a',{href:'#/rt/'+encodeURIComponent(item.source.platformSessionId),class:'rt-copy'},'查看过程'):null);
}
