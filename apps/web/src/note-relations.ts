import { createHash } from 'node:crypto';
import { noteDisplayKind, type Note } from './notes.js';
import { RelationError, type EntryRef, type NoteRelations, type RelationEdge, type RelationEvent, type RelationNode } from './note-relation-types.js';
export { RelationError } from './note-relation-types.js';
/** Stable comparison independent of JSON member order. */
export function canonical(value: unknown): string {
 if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
 if(value && typeof value==='object') return `{${Object.keys(value).sort().filter(k=>(value as Record<string,unknown>)[k]!==undefined).map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`;
 return JSON.stringify(value) ?? 'null';
}
export const relationHash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export function entryKey(ref: EntryRef): string {
 if(!ref || typeof ref!=='object') throw new RelationError('条目引用无效');
 const valid=(v:unknown)=>typeof v==='string'&&v.trim().length>0&&v.length<=500;
 if(ref.kind==='note' && Object.keys(ref).every(k=>['kind','noteId'].includes(k)) && valid(ref.noteId)) return `note:${ref.noteId}`;
 if(ref.kind==='google' && Object.keys(ref).every(k=>['kind','accountId','calendarId','eventId','seriesId'].includes(k)) && [ref.accountId,ref.calendarId,ref.eventId].every(valid) && (ref.seriesId===undefined||valid(ref.seriesId))) return `google:${JSON.stringify([ref.accountId,ref.calendarId,ref.seriesId??ref.eventId])}`;
 throw new RelationError('条目引用无效');
}
export function parseEntryKey(key: string): EntryRef {
 if(key.startsWith('note:')) {const ref:EntryRef={kind:'note',noteId:key.slice(5)};entryKey(ref);return ref;}
 if(key.startsWith('google:')) {try {const a:unknown=JSON.parse(key.slice(7));if(Array.isArray(a)&&a.length===3){const ref:EntryRef={kind:'google',accountId:a[0],calendarId:a[1],eventId:a[2]};entryKey(ref);return ref;}} catch { /* reject below */ }}
 throw new RelationError('条目引用无效');
}
export function validateMetadata(value: unknown): asserts value is NoteRelations {
 const m=value as NoteRelations;
 if(!m||m.schemaVersion!==1) throw new RelationError('关联元数据版本不支持',503);
 if(![m.edges,m.events,m.tombstones,m.receipts].every(Array.isArray)) throw new RelationError('关联元数据损坏',503);
 const date=(s:unknown)=>typeof s==='string'&&Number.isFinite(Date.parse(s));
 for(const e of m.edges){if(!e||!e.id||!['derived','related'].includes(e.type)||!date(e.createdAt)||!e.actor||!['user','runtime','backfill','system'].includes(e.actor.kind)||typeof e.actor.scopeId!=='string'||e.revokedAt!==undefined&&!date(e.revokedAt))throw new RelationError('关系结构损坏',503);entryKey(e.from);entryKey(e.to);}
 for(const e of m.events){if(!e||!e.id||!['created','derived','related','unrelated','source-corrected','kind-changed','content-changed','schedule-changed','completed','reopened','deleted','trimmed'].includes(e.type)||!['recorded','metadata','backfill'].includes(e.origin)||!date(e.occurredAt)||!date(e.recordedAt)||!Array.isArray(e.refs)||!Array.isArray(e.edgeIds)||!e.actor)throw new RelationError('关联事件损坏',503);e.refs.forEach(entryKey);}
 for(const t of m.tombstones){entryKey(t.ref);if(!date(t.removedAt)||!['deleted','trimmed'].includes(t.cause)||!Array.isArray(t.links)||Object.keys(t).some(k=>!['ref','removedAt','cause','links'].includes(k)))throw new RelationError('占位数据损坏',503);for(const l of t.links){entryKey(l.from);entryKey(l.to);}}
 for(const r of m.receipts)if(!r||![r.scopeId,r.channel,r.key,r.requestHash,r.resultId].every(s=>typeof s==='string'&&s.length>0))throw new RelationError('幂等记录损坏',503);
}
export interface RelationIndex { nodes: Map<string,RelationNode>; edges: Map<string,RelationEdge>; events: Map<string,RelationEvent>; adjacency: Map<string,Set<string>>; revision: string }
export function buildRelationIndex(notes: readonly Note[], external: readonly RelationNode[]=[]): RelationIndex {
 const nodes=new Map<string,RelationNode>(),edges=new Map<string,RelationEdge>(),events=new Map<string,RelationEvent>(),owners=new Map<string,Set<string>>();
 for(const n of notes) nodes.set(`note:${n.id}`,{ref:{kind:'note',noteId:n.id},state:'available',title:n.text.split('\n').find(Boolean)?.slice(0,120)||'无标题',displayKind:noteDisplayKind(n),relationCount:0,createdAt:n.createdAt});
 for(const n of external)nodes.set(entryKey(n.ref),structuredClone(n));
 for(const n of notes){if(!n.relations)continue;validateMetadata(n.relations);for(const e of n.relations.edges){const old=edges.get(e.id);if(old&&canonical(old)!==canonical(e))throw new RelationError('关联关系副本不一致',503);edges.set(e.id,e);const set=owners.get(e.id)??new Set();set.add(`note:${n.id}`);owners.set(e.id,set);}
 for(const e of n.relations.events){const old=events.get(e.id);if(old&&canonical(old)!==canonical(e))throw new RelationError('关联事件副本不一致',503);events.set(e.id,e);}
 for(const t of n.relations.tombstones){if(nodes.get(entryKey(t.ref))?.state==='available')throw new RelationError('占位与有效条目冲突',503);nodes.set(entryKey(t.ref),{ref:t.ref,state:'deleted',relationCount:0});for(const l of t.links)if(!edges.has(l.id))edges.set(l.id,{...l,createdAt:t.removedAt,revokedAt:t.removedAt,revocation:t.cause,actor:{kind:'system',scopeId:'history'}});}}
 const createdIds=new Set([...events.values()].filter(e=>e.type==='created').flatMap(e=>e.refs.filter(r=>r.kind==='note').map(r=>(r as {noteId:string}).noteId)));
 for(const n of notes)if(!createdIds.has(n.id)){const ev:RelationEvent={id:`meta:created:${n.id}`,origin:'metadata',type:'created',occurredAt:n.createdAt,recordedAt:n.createdAt,refs:[{kind:'note',noteId:n.id}],edgeIds:[],actor:{kind:'system',scopeId:'metadata'}};events.set(ev.id,ev);}
 const adjacency=new Map<string,Set<string>>();
 for(const e of edges.values()){
  for(const r of [e.from,e.to]){const k=entryKey(r);if(!nodes.has(k))nodes.set(k,{ref:r,state:r.kind==='note'?'deleted':'unavailable',relationCount:0});if(!e.revokedAt&&r.kind==='note'&&(nodes.get(k)?.state!=='available'||!owners.get(e.id)?.has(k)))throw new RelationError('关联关系端点副本缺失',503);}
  if(!e.revokedAt){for(const [a,b] of [[e.from,e.to],[e.to,e.from]] as const){const ak=entryKey(a),bk=entryKey(b);const set=adjacency.get(ak)??new Set();set.add(bk);adjacency.set(ak,set);}}
 }
 // Validate stored DAG independently of external availability (offline reload must remain valid).
 const indegree=new Map<string,number>(),outgoing=new Map<string,string[]>();
 for(const e of edges.values())if(!e.revokedAt&&e.type==='derived'){const a=entryKey(e.from),b=entryKey(e.to);indegree.set(a,indegree.get(a)??0);indegree.set(b,(indegree.get(b)??0)+1);outgoing.set(a,[...(outgoing.get(a)??[]),b]);}
 const ready=[...indegree].filter(([,v])=>v===0).map(([k])=>k);let processed=0;for(let i=0;i<ready.length;i++){const k=ready[i];processed++;for(const b of outgoing.get(k)??[]){indegree.set(b,indegree.get(b)!-1);if(indegree.get(b)===0)ready.push(b);}}if(processed!==indegree.size)throw new RelationError('衍生关系存在环',503);
 const index:RelationIndex={nodes,edges,events,adjacency,revision:relationHash({notes,external})};
 for(const [k,n]of nodes){n.relationCount=[...(adjacency.get(k)??[])].filter(x=>nodes.get(x)?.state==='available').length;n.verificationPending=[...(adjacency.get(k)??[])].some(x=>['pending','failed'].includes(nodes.get(x)?.verification??''));}
 return index;
}
export function directRelationCount(index: RelationIndex, ref: EntryRef): number {return index.nodes.get(entryKey(ref))?.relationCount??0;}
export function validateRelation(index: RelationIndex, edge: RelationEdge): void {
 const from=entryKey(edge.from),to=entryKey(edge.to);if(from===to)throw new RelationError('不能关联自身');
 for(const k of [from,to])if(index.nodes.get(k)?.state!=='available')throw new RelationError('来源或目标条目不存在',404);
 if(edge.type!=='derived')return;
 const next=new Map<string,string[]>();for(const e of index.edges.values())if(e.type==='derived'&&!e.revokedAt){const k=entryKey(e.from);next.set(k,[...(next.get(k)??[]),entryKey(e.to)]);}
 const seen=new Set<string>(),stack=[to];while(stack.length){const k=stack.pop()!;if(k===from)throw new RelationError('衍生关系不能形成环');if(seen.has(k))continue;seen.add(k);stack.push(...(next.get(k)??[]));}
}

interface Cursor {scope:string;revision:string;node:number;edge:number}
function queryScope(index:RelationIndex,q:import('./note-relation-types.js').GraphQuery){
 const root=entryKey(q.root);if(!index.nodes.has(root))throw new RelationError('条目不存在',404);
 if(!Array.isArray(q.expanded)||q.expanded.length>5000)throw new RelationError('展开范围无效');
 if(q.revision&&q.revision!==index.revision)throw new RelationError('关系已变化，请重新读取',409);
 const edges=[...index.edges.values()].filter(e=>!e.revokedAt||e.revocation==='deleted'||e.revocation==='trimmed');
 const adjacent=new Map<string,Set<string>>();for(const e of edges)for(const [a,b]of [[entryKey(e.from),entryKey(e.to)],[entryKey(e.to),entryKey(e.from)]]){const set=adjacent.get(a)??new Set();set.add(b);adjacent.set(a,set);}
 const centers=new Set([root]),visible=new Set([root,...(adjacent.get(root)??[])]),pending=new Set(q.expanded.map(entryKey));pending.delete(root);
 while(pending.size){let progress=false;for(const key of pending)if(visible.has(key)){centers.add(key);for(const k of adjacent.get(key)??[])visible.add(k);pending.delete(key);progress=true;}if(!progress)throw new RelationError('展开节点不在已连接范围');}
 const chosen=edges.filter(e=>centers.has(entryKey(e.from))||centers.has(entryKey(e.to))).sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)||a.id.localeCompare(b.id));
 const nodes=[...visible].map(k=>index.nodes.get(k)!).filter(Boolean).sort((a,b)=>entryKey(a.ref)===root?-1:entryKey(b.ref)===root?1:(a.createdAt??'').localeCompare(b.createdAt??'')||entryKey(a.ref).localeCompare(entryKey(b.ref)));
 return {nodes,edges:chosen,scope:relationHash({root,expanded:[...centers].sort()}),keys:visible};
}
function cursorRead(raw:string|undefined,scope:string,revision:string):Cursor {
 if(!raw)return {scope,revision,node:0,edge:0};if(raw.length>2000)throw new RelationError('游标无效');
 let p:Cursor;try{p=JSON.parse(Buffer.from(raw,'base64url').toString());}catch{throw new RelationError('游标无效');}
 if(!p||p.scope!==scope||p.revision!==revision)throw new RelationError('关系或展开范围已变化',409);
 if(!Number.isSafeInteger(p.node)||p.node<0||!Number.isSafeInteger(p.edge)||p.edge<0)throw new RelationError('游标无效');return p;
}
const cursorWrite=(c:Cursor)=>Buffer.from(JSON.stringify(c)).toString('base64url');
export function queryRelationGraph(index:RelationIndex,q:import('./note-relation-types.js').GraphQuery):import('./note-relation-types.js').GraphPage {
 const s=queryScope(index,q),c=cursorRead(q.cursor,s.scope,index.revision);if(c.node>s.nodes.length||c.edge>s.edges.length)throw new RelationError('游标越界');
 const end=Math.min(s.nodes.length,c.node+100),available=new Set(s.nodes.slice(0,end).map(n=>entryKey(n.ref)));let edgeEnd=c.edge;
 while(edgeEnd<s.edges.length&&edgeEnd-c.edge<200){const e=s.edges[edgeEnd];if(!available.has(entryKey(e.from))||!available.has(entryKey(e.to)))break;edgeEnd++;}
 const remainingNodes=s.nodes.length-end,remainingEdges=s.edges.length-edgeEnd,truncated=remainingNodes>0||remainingEdges>0;
 return {revision:index.revision,nodes:s.nodes.slice(c.node,end),edges:s.edges.slice(c.edge,edgeEnd),remainingNodes,remainingEdges,truncated,...(truncated?{nextCursor:cursorWrite({scope:s.scope,revision:index.revision,node:end,edge:edgeEnd})}:{})};
}
export function queryRelationTimeline(index:RelationIndex,q:import('./note-relation-types.js').GraphQuery):import('./note-relation-types.js').TimelinePage {
 const s=queryScope(index,q),c=cursorRead(q.cursor,`timeline:${s.scope}`,index.revision),events=[...index.events.values()].filter(e=>e.refs.some(r=>s.keys.has(entryKey(r)))).sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||a.id.localeCompare(b.id));
 if(c.node>events.length)throw new RelationError('游标越界');const end=c.node+50;return {revision:index.revision,events:events.slice(c.node,end).map(e=>e.type==='derived'?{...e,generationSummary:[...new Set(e.edgeIds.map(id=>index.edges.get(id)?.generationSummary).filter(Boolean))].join('；')||undefined}:e),scope:s.nodes.map(n=>n.ref),nodes:[...new Set([entryKey(q.root),...events.slice(c.node,end).flatMap(e=>e.refs.map(entryKey))])].map(k=>index.nodes.get(k)).filter((n):n is RelationNode=>!!n),...(end<events.length?{nextCursor:cursorWrite({scope:`timeline:${s.scope}`,revision:index.revision,node:end,edge:0})}:{})};
}
