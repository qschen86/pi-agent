/* A lazily loaded provenance view; data never crosses an authentication epoch. */
const noteRelationViews = new Map();
let noteRelationActive = null, noteRelationAuthEpoch = 0;
const relationKinds={note:'笔记',todo:'待办',event:'日程'};
const relationEventNames={created:'记录创建',derived:'从来源生成',related:'手动关联',unrelated:'解除手动关联','source-corrected':'更正来源','kind-changed':'类型调整','content-changed':'内容已修改','schedule-changed':'日程调整',completed:'标记完成',reopened:'恢复待办',deleted:'条目删除',trimmed:'容量裁剪'};
function noteRelationParseKey(key) {
 if(key.startsWith('note:'))return {kind:'note',noteId:key.slice(5)};
 if(key.startsWith('google:')){const [accountId,calendarId,eventId]=JSON.parse(key.slice(7));return {kind:'google',accountId,calendarId,eventId};}
 throw new Error('条目地址无效');
}
function noteRelationsState(root) {
 const key=noteRelationKey(root);let s=noteRelationViews.get(key);
 if(!s){s={root,key,expanded:[],tab:'graph',nodes:new Map(),timelineNodes:new Map(),edges:new Map(),events:[],revision:null,nextGraph:null,nextTimeline:null,remainingNodes:0,remainingEdges:0,scope:[],selected:null,loading:false,error:'',loaded:false,graphLoaded:false,timelineLoaded:false,graphDirty:false,blocked:false,generation:0,view:{},el:h('section',{class:'entry-relations','aria-label':'条目关系'})};noteRelationViews.set(key,s);}
 return s;
}
function noteRelationsRender(root) {
 ui.relationRootKey=noteRelationKey(root);noteRelationActive=noteRelationsState(root);noteRelationActive.disposed=false;
 const el=renderNoteRelations();document.getElementById('main')?.replaceChildren(el);
}
function renderNoteRelations() {
 try {
  const root=noteRelationParseKey(ui.relationRootKey||decodeURIComponent(location.hash.split('/relations/')[1]||''));const s=noteRelationsState(root);noteRelationActive=s;s.disposed=false;noteRelationsDraw(s);
  if(!s.blocked&&!(s.tab==='graph'?s.graphLoaded:s.timelineLoaded)&&!s.loading)queueMicrotask(()=>{if(!s.disposed&&noteRelationActive===s)void noteRelationsLoad(true);});return s.el;
 } catch(e){return h('section',{class:'card'},h('p',{role:'alert'},e.message),h('a',{href:'#/notes',class:'btn'},'返回记录'));}
}
function noteRelationsDispose(clear=false) {
 const s=noteRelationActive;if(s){s.disposed=true;s.generation++;s.abort?.abort();s.graph?.dispose();s.loading=false;s.loaded=false;s.graphLoaded=false;s.timelineLoaded=false;}
 if(clear){noteRelationAuthEpoch++;for(const v of noteRelationViews.values()){v.el.replaceChildren(h('p',{class:'field-error',role:'alert'},'访问状态已变化，请重新读取'));v.disposed=true;v.generation++;v.abort?.abort();v.graph?.dispose();}noteRelationViews.clear();noteRelationActive=null;}
}
async function noteRelationsLoad(reset=false,retryConflict=true) {
 const s=noteRelationActive;if(!s||s.disposed)return;if(s.loading){if(reset)s.refreshAfter=true;return;}s.loading=true;s.error='';s.blocked=false;const gen=++s.generation,epoch=noteRelationAuthEpoch;s.abort?.abort();s.abort=new AbortController();noteRelationsDraw(s);
 const current=()=>s===noteRelationActive&&!s.disposed&&s.generation===gen&&epoch===noteRelationAuthEpoch&&!ui.authRequired;
 const q=new URLSearchParams({root:s.key,expanded:JSON.stringify(s.expanded)});if(!reset&&s.revision)q.set('revision',s.revision);if(!reset){const cursor=s.tab==='graph'?s.nextGraph:s.nextTimeline;if(cursor)q.set('cursor',cursor);}
 let again=false;
 try {
  const data=await api(`/api/note-relations/${s.tab==='graph'?'graph':'timeline'}?${q}`,{signal:s.abort.signal});if(!current())return;
  if(s.tab==='graph'){
   if(reset){s.nodes.clear();s.edges.clear();if(s.revision!==data.revision){s.events=[];s.timelineNodes.clear();s.nextTimeline=null;s.timelineLoaded=false;}}
   s.graphLoaded=true;s.graphDirty=false;
   for(const node of data.nodes||[])s.nodes.set(noteRelationKey(node.ref),node);for(const edge of data.edges||[])s.edges.set(edge.id,edge);
   s.revision=data.revision;s.nextGraph=data.nextCursor||null;s.remainingNodes=data.remainingNodes||0;s.remainingEdges=data.remainingEdges||0;
  }else {
   if(reset){s.timelineNodes.clear();s.events=[];}
   if(s.revision!==data.revision){s.nodes.clear();s.edges.clear();s.graphLoaded=false;s.graphDirty=true;}
   for(const n of data.nodes||[])s.timelineNodes.set(noteRelationKey(n.ref),n);
   s.revision=data.revision;s.events=reset?(data.events||[]):[...new Map([...s.events,...(data.events||[])].map(e=>[e.id,e])).values()];s.scope=data.scope||[];s.nextTimeline=data.nextCursor||null;s.timelineLoaded=true;
  }
  s.loaded=true;
 }catch(e){if(!current())return;if(e.status===401){noteRelationsDispose(true);return;}if(e.status===403||e.status===404){s.nodes.clear();s.timelineNodes.clear();s.edges.clear();s.events=[];s.graphLoaded=false;s.timelineLoaded=false;s.blocked=true;}s.error=e.status===409?'关系已变化，正在重新读取当前范围':e.message||'读取失败';again=e.status===409&&retryConflict;}
 finally{if(current()){s.loading=false;noteRelationsDraw(s);}}
 if(again)await noteRelationsLoad(true,false);
 else if(s.refreshAfter&&current()){s.refreshAfter=false;await noteRelationsLoad(true);}
}
function noteRelationTitle(s,ref){const n=s.tab==='timeline'?s.timelineNodes.get(noteRelationKey(ref)):s.nodes.get(noteRelationKey(ref));return n?.state==='deleted'?'已删除条目':n?.state==='unavailable'?'外部日程暂不可用':n?.title||'来源条目';}
function noteRelationsOpen(ref) {if(ref.kind==='note'){noteRelationsDispose();noteOpenNoteById(ref.noteId);}else{location.hash=noteRelationsHref(ref);}}
function noteRelationsSelect(ref) {const s=noteRelationActive;if(!s)return;s.selected=noteRelationKey(ref);noteRelationsDraw(s);}
async function noteRelationsExpand(ref){const s=noteRelationActive;if(!s||s.loading)return;if(!s.expanded.some(r=>noteRelationKey(r)===noteRelationKey(ref)))s.expanded.push(ref);s.loaded=false;await noteRelationsLoad(true);}
function noteRelationsChangeTab(tab){const s=noteRelationActive;if(!s||s.tab===tab)return;s.abort?.abort();s.generation++;s.loading=false;s.tab=tab;noteRelationsDraw(s);if(!(tab==='graph'?s.graphLoaded:s.timelineLoaded))void noteRelationsLoad(true);}
function noteRelationVerification(node){
 if(node?.ref.kind!=='google')return null;
 const last=node.checkedAt?'；上次核验：'+new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(new Date(node.checkedAt))+'（北京时间）':'；尚无成功核验记录';
 const status=node.verification==='failed'?'本次核验失败，展示上次核验状态':node.verification==='pending'?'正在核验外部日程，当前为缓存状态':node.state==='available'?'外部日程已核验可用':'外部日程暂不可用';
 return h('p',{class:'muted small relation-verification',role:'status'},status+last);
}
function noteRelationsDraw(s) {
 if(s.disposed)return;const active=document.activeElement?.dataset?.relationFocus,activeNode=document.activeElement?.getAttribute?.('data-relation-node'),scroll=s.el.querySelector('.relation-content')?.scrollTop||0;
 const center=(s.tab==='timeline'?s.timelineNodes.get(s.key):s.nodes.get(s.key)),title=center?noteRelationTitle(s,s.root):'条目关系',count=center?.relationCount??0;
 const header=h('header',{class:'relation-header'},h('a',{class:'btn small',href:'#/notes','aria-label':'返回记录'},'‹ 记录'),h('div',{class:'relation-heading'},h('p',{class:'relation-eyebrow'},'知识图谱 / 演进过程'),h('h1',{},title)),h('span',{class:'relation-count-label'},`关联 ${count}${center?.verificationPending?' · 待核验':''}`));
 const actions=h('div',{class:'relation-main-actions'},noteRelatedMenu(s.root,s.loading),h('button',{class:'btn small',type:'button',disabled:s.loading,onclick:()=>void noteOpenRelationPicker(s.root)},'关联已有条目'),h('button',{class:'btn small',type:'button',disabled:s.loading,onclick:()=>void noteRelationsLoad(true)},'刷新关系'));
 const tabs=h('div',{class:'relation-tabs inpage-tabs',role:'tablist','aria-label':'关系视图'},...['graph','timeline'].map((tab,i)=>h('button',{type:'button',role:'tab',class:s.tab===tab?'active':'','aria-selected':String(s.tab===tab),'data-relation-focus':tab,onclick:()=>noteRelationsChangeTab(tab)},['图谱','演进过程'][i])));
 const body=h('div',{class:'relation-content','data-keep-scroll':'relations'},s.error?h('p',{class:'field-error',role:'alert'},s.error):null,s.loading?h('p',{class:'muted small',role:'status'},'正在读取关联…'):null);
 const status=noteRelationVerification(center);if(status)body.append(status);
 s.graph?.dispose();s.graph=null;
 if(s.tab==='graph'){
  if(s.nodes.size)body.append(h('p',{class:'muted small'},`当前已展开范围：${s.nodes.size} 个条目；选择节点可展开更多关联。`));
  if(s.nodes.size>1){const canvas=h('div',{class:'relation-graph'});body.append(canvas);s.graph=noteRelationGraphRender(canvas,{nodes:[...s.nodes.values()],edges:[...s.edges.values()]},{rootKey:s.key,view:s.view,selectedKey:s.selected,select:noteRelationsSelect,expand:ref=>void noteRelationsExpand(ref)});}
  else if(s.loaded)body.append(h('div',{class:'relation-empty'},h('strong',{},'让这条记录成为下一步的起点'),h('p',{class:'muted'},'从这里创建笔记、待办或日程，来源会自动保留下来。')));
  if(s.selected){const n=s.nodes.get(s.selected);if(n){const incoming=[...s.edges.values()].filter(e=>noteRelationKey(e.to)===s.selected&&e.type==='derived');body.append(h('aside',{class:'relation-node-detail'},h('p',{class:'relation-eyebrow'},n.state==='available'?(relationKinds[n.displayKind]||'条目'):'历史占位'),h('h2',{},noteRelationTitle(s,n.ref)),noteRelationVerification(n),...incoming.map(e=>h('p',{class:'muted small'},e.generationSummary||'未记录生成说明')),h('div',{class:'relation-main-actions'},n.state==='available'&&n.ref.kind==='note'?h('button',{class:'btn primary',type:'button',onclick:()=>noteRelationsOpen(n.ref)},'打开条目'):null,h('button',{class:'btn small',type:'button',disabled:s.loading,onclick:()=>void noteRelationsExpand(n.ref)},'展开关联'))));}}
  if(s.nextGraph)body.append(h('button',{class:'btn',type:'button',disabled:s.loading,onclick:()=>void noteRelationsLoad(false)},`继续加载（还剩 ${s.remainingNodes} 个节点、${s.remainingEdges} 条关系）`));
  const list=h('ul',{class:'relation-adjacency','aria-label':'已加载条目列表'},...[...s.nodes.values()].map(n=>h('li',{},h('button',{class:'relation-list-node',type:'button','aria-label':`选择：${noteRelationTitle(s,n.ref)}`,onclick:()=>noteRelationsSelect(n.ref)},h('span',{class:'relation-kind'},relationKinds[n.displayKind]||'历史'),h('span',{},noteRelationTitle(s,n.ref)),h('span',{class:'muted small'},`关联 ${n.relationCount}`)))));if(s.nodes.size)body.append(h('details',{class:'relation-readable'},h('summary',{},`以列表查看（${s.nodes.size}）`),list));
  const direct=[...s.edges.values()].filter(e=>!e.revokedAt&&(noteRelationKey(e.from)===s.key||noteRelationKey(e.to)===s.key));if(direct.length)body.append(h('section',{class:'relation-edge-list'},h('h2',{},'直接关系'),...direct.map(e=>h('div',{class:'relation-edge-row'},h('span',{},`${noteRelationTitle(s,e.from)} ${e.type==='derived'?'→':'↔'} ${noteRelationTitle(s,e.to)}`),h('button',{class:'btn small',type:'button',disabled:s.loading,onclick:()=>void noteRelationsRevoke(e)},e.type==='derived'?'更正来源':'解除关联')))));
 }else{
  body.append(h('p',{class:'muted small'},`当前已展开范围：${s.scope.length||s.nodes.size} 个条目 · 时间为北京时间`));
  const list=h('ol',{class:'relation-timeline'});for(const ev of s.events){const edges=ev.edgeIds.map(id=>s.edges.get(id)).filter(Boolean),time=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(ev.occurredAt));list.append(h('li',{},h('time',{datetime:ev.occurredAt},time),h('div',{},h('strong',{},relationEventNames[ev.type]||'关系变化'),h('p',{class:'muted small'},ev.origin==='metadata'?'依据记录创建时间':ev.actor?.kind==='runtime'?'会话生成':ev.origin==='backfill'?'可信创建证据补录':'记录操作'),h('div',{class:'relation-event-refs'},...ev.refs.map(ref=>h('button',{class:'btn small',type:'button',disabled:s.timelineNodes.get(noteRelationKey(ref))?.state!=='available',onclick:()=>noteRelationsOpen(ref)},noteRelationTitle(s,ref)))),ev.type==='derived'?h('p',{class:'relation-generation-summary'},ev.generationSummary || '未记录生成说明'):null,ev.evidence?.sessionId?h('a',{class:'btn small',href:'#/rt/'+encodeURIComponent(ev.evidence.sessionId)},'查看会话'):null,ev.origin==='backfill'?h('p',{class:'muted small'},'补录时间：'+new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short'}).format(new Date(ev.recordedAt))):null)));}body.append(list);if(!s.events.length&&!s.loading)body.append(h('p',{class:'muted'},'当前范围暂无演进记录'));if(s.nextTimeline)body.append(h('button',{class:'btn',type:'button',disabled:s.loading,onclick:()=>void noteRelationsLoad(false)},'加载后续步骤'));
 }
 s.el.replaceChildren(header,actions,tabs,body);body.scrollTop=scroll;if(active)[...s.el.querySelectorAll('[data-relation-focus]')].find(el=>el.dataset.relationFocus===active)?.focus({preventScroll:true});else if(activeNode)[...s.el.querySelectorAll('[data-relation-node]')].find(el=>el.getAttribute('data-relation-node')===activeNode)?.focus({preventScroll:true});
}
async function noteRelationsRevoke(edge){const s=noteRelationActive;if(!s||s.loading)return;const derived=edge.type==='derived';if(!confirm(derived?'更正此来源？原关系会保留在演进历史中。':'解除此关联？条目本身不会删除。'))return;const reason=derived?prompt('可选：来源更正说明')||undefined:undefined;try{await api(`/api/note-relations/${encodeURIComponent(edge.id)}/revoke`,{method:'POST',body:JSON.stringify({reason})});if(s===noteRelationActive)await noteRelationsLoad(true);}catch(e){if(s===noteRelationActive){s.error=e.message;noteRelationsDraw(s);}}}
async function noteOpenRelationPicker(root){
 const epoch=noteRelationAuthEpoch,dialog=h('dialog',{class:'relation-picker','aria-label':'关联已有条目'}),search=h('input',{type:'search','aria-label':'搜索已有条目',placeholder:'搜索标题或正文'}),kind=h('select',{'aria-label':'筛选条目类型'},...['all','note','todo','event'].map((k,i)=>h('option',{value:k},['全部','笔记','待办','日程'][i]))),results=h('div',{class:'relation-picker-results'}),error=h('p',{class:'field-error',role:'alert'});let generation=0,timer,closed=false;
 const close=()=>{closed=true;generation++;clearTimeout(timer);dialog.close();dialog.remove();};
 const load=async()=>{const gen=++generation;results.replaceChildren(h('p',{class:'muted'},'正在搜索…'));try{const q=new URLSearchParams({limit:'20',status:'all',q:search.value});if(kind.value!=='all')q.set('kind',kind.value);const data=await api('/api/notes?'+q);if(closed||gen!==generation||epoch!==noteRelationAuthEpoch)return;let candidates=(data.notes||data||[]).map(n=>({ref:{kind:'note',noteId:n.id},title:n.text,displayKind:noteDisplayKind(n)}));
  if(kind.value==='all'||kind.value==='event'){const from=new Date(Date.now()-31*86400000),to=new Date(+from+365*86400000);try{const ext=await api('/api/calendar/google?'+new URLSearchParams({from:from.toISOString(),to:to.toISOString()}));if(closed||gen!==generation||epoch!==noteRelationAuthEpoch)return;const query=search.value.toLowerCase();candidates.push(...(ext.google||[]).filter(e=>e.relationRef&&e.title.toLowerCase().includes(query)).map(e=>({ref:e.relationRef,title:e.title,displayKind:'event'})));}catch{/* Local search remains usable when the calendar is unavailable. */}}
  const seen=new Set(),idx=noteRelationActive;results.replaceChildren(...candidates.filter(n=>{const key=noteRelationKey(n.ref);if(key===noteRelationKey(root)||seen.has(key))return false;seen.add(key);return true;}).map(n=>{const existing=idx&&[...idx.edges.values()].some(e=>!e.revokedAt&&[noteRelationKey(e.from),noteRelationKey(e.to)].includes(noteRelationKey(root))&&[noteRelationKey(e.from),noteRelationKey(e.to)].includes(noteRelationKey(n.ref)));return h('button',{class:'relation-picker-result',type:'button',disabled:!!existing,onclick:async()=>{try{await api('/api/note-relations',{method:'POST',body:JSON.stringify({from:root,to:n.ref,idempotencyKey:noteRelationRequestKey()})});if(epoch!==noteRelationAuthEpoch)return;close();if(noteRelationActive)await noteRelationsLoad(true);}catch(e){error.textContent=e.message;}}},h('span',{},n.title.slice(0,140)),h('span',{class:'muted small'},existing?'已关联':relationKinds[n.displayKind]));}));if(!results.childNodes.length)results.append(h('p',{class:'muted'},'没有可关联的条目'));
 }catch(e){if(!closed&&gen===generation){error.textContent=e.message;results.replaceChildren();}}};
 search.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(()=>void load(),200);});kind.addEventListener('change',()=>void load());dialog.append(h('header',{class:'relation-picker-head'},h('h2',{},'关联已有条目'),h('button',{class:'btn small',type:'button',onclick:close},'关闭')),h('div',{class:'relation-picker-filters'},search,kind),h('p',{class:'muted small'},'外部日程搜索范围：前 31 天至未来约 11 个月；更早日程可从日历详情关联。'),error,results);dialog.addEventListener('cancel',e=>{e.preventDefault();close();});document.body.append(dialog);dialog.showModal();search.focus();await load();
}
document.addEventListener('gui-auth-required',()=>{document.querySelectorAll('.relation-picker').forEach(d=>d.remove());noteRelationsDispose(true);});
window.piRouteModules?.register('note-relations',{render:renderNoteRelations});
