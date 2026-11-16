import { randomUUID } from 'node:crypto';
import type { Note } from './notes.js';
import { canonical, entryKey, relationHash } from './note-relations.js';
import { emptyRelations, type RelationActor, type RelationContext, type RelationEvent, type RelationEventType } from './note-relation-types.js';
const user:RelationActor={kind:'user',scopeId:'local'};
export function prepareRelationHistory(before: readonly Note[], after: Note[], cause:'deleted'|'trimmed'='deleted', context?:RelationContext,at=new Date().toISOString()):void {
 const old=new Map(before.map(n=>[n.id,n])),remaining=new Set(after.map(n=>n.id));
 for(const n of after){const prev=old.get(n.id),types:RelationEventType[]=[];
  if(!prev)types.push('created');else {
   if(canonical([prev.text,prev.images])!==canonical([n.text,n.images]))types.push('content-changed');
   if(canonical(prev.schedule)!==canonical(n.schedule))types.push('schedule-changed');
   if((prev.kind??'todo')!==(n.kind??'todo'))types.push('kind-changed');
   if(!!prev.done!==!!n.done)types.push(n.done?'completed':'reopened');
  }
  for(const type of types){const ev:RelationEvent={id:`re-${randomUUID()}`,origin:'recorded',type,occurredAt:type==='created'?n.createdAt:at,recordedAt:at,refs:[{kind:'note',noteId:n.id}],edgeIds:[],actor:context?.actor??user,...(context?.evidence?{evidence:context.evidence}:{}),...(type==='content-changed'?{contentHash:relationHash([n.text,n.images])}:{})};(n.relations??=emptyRelations()).events.push(ev);}
 }
 for(const removed of before.filter(n=>!remaining.has(n.id))){
  const ref={kind:'note' as const,noteId:removed.id},key=entryKey(ref),m=removed.relations??emptyRelations();
  const allLinks=[...m.edges.filter(e=>!e.revokedAt||e.revocation==='deleted'||e.revocation==='trimmed').map(e=>({id:e.id,type:e.type,from:e.from,to:e.to})),...m.tombstones.flatMap(t=>t.links)];
  const neighbors=new Set(allLinks.flatMap(l=>[l.from,l.to]).filter(r=>r.kind==='note'&&r.noteId!==removed.id&&remaining.has(r.noteId)).map(entryKey));
  const tombstone={ref,removedAt:at,cause,links:[...new Map(allLinks.map(l=>[l.id,l])).values()]};
  const ev:RelationEvent={id:`re-${randomUUID()}`,origin:'recorded',type:cause,occurredAt:at,recordedAt:at,refs:[ref],edgeIds:m.edges.filter(e=>entryKey(e.from)===key||entryKey(e.to)===key).map(e=>e.id),actor:context?.actor??user};
  for(const n of after){if(!neighbors.has(`note:${n.id}`))continue;const dest=n.relations??=emptyRelations();
   for(const e of m.edges)if(!dest.edges.some(x=>x.id===e.id))dest.edges.push(structuredClone(e));
   for(const t of [...m.tombstones,tombstone])if(!dest.tombstones.some(x=>entryKey(x.ref)===entryKey(t.ref)))dest.tombstones.push(structuredClone(t));
   for(const r of m.receipts)if(!dest.receipts.some(x=>canonical(x)===canonical(r)))dest.receipts.push(structuredClone(r));
   for(const e of [...m.events,ev])if(!dest.events.some(x=>x.id===e.id))dest.events.push(structuredClone(e));
  }
  for(const n of after)for(const e of n.relations?.edges??[])if(entryKey(e.from)===key||entryKey(e.to)===key){if(!e.revokedAt){e.revokedAt=at;e.revocation=cause;}delete e.generationSummary;}
 }
}
