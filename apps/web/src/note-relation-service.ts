import { randomUUID } from 'node:crypto';
import type { Note, NoteStore } from './notes.js';
import { NOTE_MAX_COUNT } from './notes.js';
import { buildRelationIndex, canonical, entryKey, relationHash, validateRelation, queryRelationGraph, queryRelationTimeline } from './note-relations.js';
import { emptyRelations, RelationError, type EntryRef, type RelationContext, type RelationEdge, type RelationEvent, type RelationNode, type RelationReceipt, type GraphQuery } from './note-relation-types.js';
export interface RelationCreateInput {text?:unknown;images?:unknown;schedule?:unknown;schedulePending?:unknown;kind?:unknown;timeZone?:unknown;pinned?:unknown;automation?:unknown;sourceRefs?:unknown;generationSummary?:unknown;idempotencyKey?:unknown}
type Creator=(input:RelationCreateInput,apply:(notes:Note[],note:Note)=>void,context:RelationContext)=>Note;
export function relationSources(value:unknown):EntryRef[]{
 if(value===undefined)return [];if(!Array.isArray(value)||value.length>100)throw new RelationError('来源最多 100 项');
 const refs=value as EntryRef[];refs.forEach(entryKey);return [...new Map(refs.map(r=>[entryKey(r),structuredClone(r)])).values()].sort((a,b)=>entryKey(a).localeCompare(entryKey(b)));
}
export class NoteRelationService {
 readonly externalNodes=new Map<string,RelationNode>();
 externalAuthorized?: (ref:EntryRef)=>boolean;
 resolveExternal?: (ref:EntryRef)=>Promise<RelationNode>;
 private externalRefreshFlight?:Promise<void>;
 private lastExternalRefreshAt=0;
 private externalFlights=new Map<string,Promise<void>>();
 constructor(readonly store:NoteStore,private readonly creator:Creator,private readonly changed:()=>void){}
 private resolveOne(ref:EntryRef):Promise<void>{
  const key=entryKey(ref),flight=this.externalFlights.get(key);if(flight)return flight;
  const previous=this.externalNodes.get(key);
  this.externalNodes.set(key,previous?{...previous,verification:'pending'}:{ref,state:'unavailable',relationCount:0,verification:'pending'});
  const work=(async()=>{
   try{
    if(!this.resolveExternal||this.externalAuthorized&&!this.externalAuthorized(ref)){this.externalNodes.set(key,{ref,state:'unavailable',relationCount:0});return;}
    const node=await this.resolveExternal(ref);this.externalNodes.set(key,{...node,verification:'ready'});
   }catch{this.externalNodes.set(key,previous?{...previous,verification:'failed'}:{ref,state:'unavailable',relationCount:0,verification:'failed'});}
  })().finally(()=>{this.externalFlights.delete(key);this.changed();});
  this.externalFlights.set(key,work);return work;
 }
 async refreshExternal():Promise<void>{
  const refs=new Map<string,EntryRef>();for(const n of this.store.list())for(const e of n.relations?.edges??[])for(const r of [e.from,e.to])if(r.kind==='google')refs.set(entryKey(r),r);
  const queue=[...refs.values()];let i=0;await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{while(i<queue.length)await this.resolveOne(queue[i++]);}));
 }
 scheduleExternalRefresh():void{
  if(this.externalRefreshFlight||Date.now()-this.lastExternalRefreshAt<60000)return;
  this.lastExternalRefreshAt=Date.now();this.externalRefreshFlight=this.refreshExternal().catch(()=>{}).finally(()=>{this.externalRefreshFlight=undefined;});
 }
 private async ensureRoot(ref:EntryRef):Promise<void>{
  if(ref.kind!=='google'||this.externalNodes.has(entryKey(ref)))return;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([this.resolveOne(ref),new Promise<void>(resolve=>{timer=setTimeout(resolve,1500);})]);}finally{if(timer)clearTimeout(timer);}
  if(!this.externalNodes.has(entryKey(ref)))this.externalNodes.set(entryKey(ref),{ref,state:'unavailable',relationCount:0,verification:'pending'});
 }
 index(){for(const [key,n]of this.externalNodes)if(this.externalAuthorized&&!this.externalAuthorized(n.ref))this.externalNodes.set(key,{ref:n.ref,state:'unavailable',relationCount:0});return buildRelationIndex(this.store.list(),[...this.externalNodes.values()]);}
 decorate<T extends {id:string}>(notes:T[]):Array<T&{relationCount:number;relationRevision:string;relationVerificationPending?:boolean;relationError?:string}>{
  try{const idx=this.index();return notes.map(n=>({...n,relationCount:idx.nodes.get('note:'+n.id)?.relationCount??0,relationRevision:idx.revision,relationVerificationPending:idx.nodes.get('note:'+n.id)?.verificationPending??false}));}
  catch(e){return notes.map(n=>({...n,relationCount:0,relationRevision:'unavailable',relationError:(e as Error).message}));}
 }
 private receipt(context:RelationContext,key:unknown,request:unknown):RelationReceipt {
  if(typeof key!=='string'||!key.trim()||key.length>200)throw new RelationError('需要有效的幂等键（最多 200 字符）');
  return {scopeId:context.channel==='web'?'platform-owner':context.actor.scopeId,channel:context.channel,key,requestHash:relationHash(request),resultId:''};
 }
 private findReceipt(r:RelationReceipt):RelationReceipt|undefined {
  const found=this.store.relationReceipts().find(x=>x.scopeId===r.scopeId&&x.channel===r.channel&&x.key===r.key);
  if(found&&found.requestHash!==r.requestHash)throw new RelationError('同一幂等键对应不同请求',409);return found;
 }
 async verifySources(refs:EntryRef[]):Promise<EntryRef[]>{const copy=relationSources(refs);await this.verify(copy);return copy;}
 private async verify(refs:EntryRef[]):Promise<void>{
  for(const [i,ref] of refs.entries()){if(ref.kind==='note'){if(!this.store.get(ref.noteId))throw new RelationError('来源或目标条目不存在',404);}else{if(!this.resolveExternal)throw new RelationError('外部日程暂不可用',503);const node=await this.resolveExternal(ref);this.externalNodes.set(entryKey(node.ref),node);refs[i]=node.ref;if(node.state!=='available')throw new RelationError('外部日程暂不可用',404);}}
 }
 async create(input:RelationCreateInput,context:RelationContext):Promise<Note>{
  const refs=relationSources(input.sourceRefs);
  if(input.generationSummary!==undefined&&(typeof input.generationSummary!=='string'||input.generationSummary.length>1000))throw new RelationError('生成说明最多 1000 字符');
  const summary=typeof input.generationSummary==='string'?input.generationSummary.trim():undefined;
  const receipt=this.receipt(context,input.idempotencyKey??(!refs.length?randomUUID():undefined),{text:typeof input.text==='string'?input.text.trim():input.text,images:input.images??[],schedule:input.schedule??null,schedulePending:input.schedulePending??null,kind:input.kind??null,pinned:input.pinned??false,automation:input.automation??null,refs:refs.map(entryKey).sort(),summary:summary??null});
  const prior=this.findReceipt(receipt);if(prior){const note=this.store.get(prior.resultId);if(!note)throw new RelationError('此前创建的条目已删除',404);return this.decorate([note])[0];}
  await this.verify(refs);
  refs.splice(0,refs.length,...relationSources(refs));
  const concurrent=this.findReceipt(receipt);if(concurrent){const note=this.store.get(concurrent.resultId);if(!note)throw new RelationError('此前创建的条目已删除',404);return this.decorate([note])[0];}
  const result=this.creator(input,(draft,note)=>{
   for(const ref of refs)if(ref.kind==='note'&&!draft.some(n=>n.id===ref.noteId))throw new RelationError('来源条目已删除',404);
   const trimmed=draft.slice(NOTE_MAX_COUNT);if(refs.some(r=>r.kind==='note'&&trimmed.some(n=>n.id===r.noteId)))throw new RelationError('请先清理空间：来源将被容量裁剪',409);
   const m=note.relations??=emptyRelations();m.receipts.push({...receipt,resultId:note.id});
   for(const ref of refs){const e:RelationEdge={id:`rel-${randomUUID()}`,type:'derived',from:ref,to:{kind:'note',noteId:note.id},createdAt:note.createdAt,actor:context.actor,...(summary?{generationSummary:summary}:{}),...(context.evidence?{evidence:context.evidence}:{})};
    validateRelation(buildRelationIndex(draft,[...this.externalNodes.values()]),e);m.edges.push(e);
    if(ref.kind==='note'){const source=draft.find(n=>n.id===ref.noteId)!;const sm=source.relations??=emptyRelations();sm.edges.push(structuredClone(e));sm.receipts.push({...receipt,resultId:note.id});}
   }
   if(refs.length){const ev:RelationEvent={id:`re-${randomUUID()}`,origin:'recorded',type:'derived',occurredAt:note.createdAt,recordedAt:note.createdAt,refs:[...refs,{kind:'note',noteId:note.id}],edgeIds:m.edges.map(e=>e.id),actor:context.actor,...(context.evidence?{evidence:context.evidence}:{})};for(const n of draft)if(n.id===note.id||refs.some(r=>r.kind==='note'&&r.noteId===n.id))(n.relations??=emptyRelations()).events.push(structuredClone(ev));}
  },context);
  return this.decorate([result])[0];
 }
 async relate(from:EntryRef,to:EntryRef,context:RelationContext,key:string):Promise<RelationEdge>{
  entryKey(from);entryKey(to);if(from.kind!=='note'&&to.kind!=='note')throw new RelationError('至少一端必须为本地条目');const verified=[from,to];await this.verify(verified);[from,to]=verified;
  if(entryKey(from)>entryKey(to))[from,to]=[to,from];const receipt=this.receipt(context,key,{from,to,type:'related'});const prior=this.findReceipt(receipt);if(prior){const original=this.index().edges.get(prior.resultId);if(!original)throw new RelationError('此前关联已不存在',404);return original;}
  const idx=this.index(),existing=[...idx.edges.values()].find(e=>!e.revokedAt&&[entryKey(e.from),entryKey(e.to)].sort().join('\n')===[entryKey(from),entryKey(to)].sort().join('\n'));
  if(existing)return existing;
  const edge:RelationEdge={id:`rel-${randomUUID()}`,type:'related',from,to,createdAt:new Date().toISOString(),actor:context.actor};validateRelation(idx,edge);
  this.store.mutateRelations(ns=>{const ev:RelationEvent={id:`re-${randomUUID()}`,origin:'recorded',type:'related',occurredAt:edge.createdAt,recordedAt:edge.createdAt,refs:[from,to],edgeIds:[edge.id],actor:context.actor};for(const n of ns)if([from,to].some(r=>r.kind==='note'&&r.noteId===n.id)){const m=n.relations??=emptyRelations();m.edges.push(structuredClone(edge));m.events.push(structuredClone(ev));m.receipts.push({...receipt,resultId:edge.id});}},context);this.changed();return edge;
 }
 async graph(q:GraphQuery){this.scheduleExternalRefresh();await this.ensureRoot(q.root);return queryRelationGraph(this.index(),q);}
 async timeline(q:GraphQuery){this.scheduleExternalRefresh();await this.ensureRoot(q.root);return queryRelationTimeline(this.index(),q);}
 async revoke(id:string,reason:string|undefined,context:RelationContext):Promise<void>{
  if(reason!==undefined&&(typeof reason!=='string'||reason.length>1000))throw new RelationError('更正说明最多 1000 字符');
  const e=this.index().edges.get(id);if(!e)throw new RelationError('关系不存在',404);if(e.revokedAt)return;
  const at=new Date().toISOString(),ev:RelationEvent={id:`re-${randomUUID()}`,origin:'recorded',type:e.type==='derived'?'source-corrected':'unrelated',occurredAt:at,recordedAt:at,refs:[e.from,e.to],edgeIds:[id],actor:context.actor};
  this.store.mutateRelations(ns=>{for(const n of ns){const edges=n.relations?.edges.filter(x=>x.id===id)??[];for(const edge of edges){edge.revokedAt=at;edge.revocation=e.type==='derived'?'source-corrected':'unrelated';if(reason)edge.revokeReason=reason;}if(edges.length)n.relations!.events.push(structuredClone(ev));}},context);this.changed();
 }
}

export function resolveRecordSources(binding:import('../../../packages/runtime-sessions/src/types.js').SessionBinding,explicit?:EntryRef[]):EntryRef[]{
 if(explicit!==undefined)return relationSources(explicit);
 if(binding.recordSourceRefs!==undefined)return relationSources(binding.recordSourceRefs);
 if(binding.noteRef)return [{kind:'note',noteId:binding.noteRef.noteId}];
 return relationSources(binding.recommendationRef?.sources.map(s=>({kind:'note',noteId:s.noteId}))??[]);
}
