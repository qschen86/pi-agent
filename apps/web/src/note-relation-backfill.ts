import type {NoteStore} from './notes.js';
import {buildRelationIndex,entryKey,relationHash,validateRelation} from './note-relations.js';
import {emptyRelations,type EntryRef,type RelationActor,type RelationEvidence,type RelationEdge,type RelationEvent} from './note-relation-types.js';
export interface VerifiedCreationEvidence {evidenceKey:string;sources:EntryRef[];resultNoteId:string;occurredAt:string;recordedAt:string;actor:RelationActor;evidence:RelationEvidence}
/** Internal trusted evidence only: there is deliberately no public backfill endpoint. */
export function backfillRelations(store:NoteStore,evidence:readonly VerifiedCreationEvidence[]):{added:number;skipped:number}{
 let added=0,skipped=0;
 for(const item of evidence){const rows=store.list();if(!item.evidenceKey||!item.evidence.sessionId||!item.evidence.toolCallId||!item.sources.length||!rows.some(n=>n.id===item.resultNoteId)||item.sources.some(r=>r.kind!=='note'||!rows.some(n=>n.id===r.noteId))||rows.some(n=>n.relations?.events.some(e=>e.evidence?.evidenceKey===item.evidenceKey))){skipped++;continue;}
  store.mutateRelations(ns=>{const idx=buildRelationIndex(ns),newEdges:RelationEdge[]=[];for(const source of [...new Map(item.sources.map(r=>[entryKey(r),r])).values()]){const edge:RelationEdge={id:`rel-${relationHash([item.evidenceKey,source,item.resultNoteId]).slice(0,32)}`,type:'derived',from:source,to:{kind:'note',noteId:item.resultNoteId},createdAt:item.occurredAt,actor:{...item.actor,kind:'backfill'},evidence:{...item.evidence,evidenceKey:item.evidenceKey}};validateRelation(idx,edge);if([...idx.edges.values()].some(e=>!e.revokedAt&&e.type==='derived'&&entryKey(e.from)===entryKey(edge.from)&&entryKey(e.to)===entryKey(edge.to)))continue;idx.edges.set(edge.id,edge);newEdges.push(edge);}
   const ev:RelationEvent={id:`re-${relationHash(item.evidenceKey).slice(0,32)}`,origin:'backfill',type:'derived',occurredAt:item.occurredAt,recordedAt:item.recordedAt,refs:[...item.sources,{kind:'note',noteId:item.resultNoteId}],edgeIds:newEdges.map(e=>e.id),actor:{...item.actor,kind:'backfill'},evidence:{...item.evidence,evidenceKey:item.evidenceKey}};
   for(const n of ns){const local=newEdges.filter(e=>[e.from,e.to].some(r=>r.kind==='note'&&r.noteId===n.id));if(local.length){const m=n.relations??=emptyRelations();m.edges.push(...structuredClone(local));m.events.push(structuredClone(ev));}}
   added+=newEdges.length;
  });
 }
 return {added,skipped};
}
