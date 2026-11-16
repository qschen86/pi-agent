import {it,expect} from 'vitest';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openFactLedger} from '../src/facts/ledger.js';
import {factKey} from '../src/facts/schema.js';
import type {FactCandidate} from '../../runtime-memory/src/facts-contract.js';
it('persists evidence, decisions, CAS revisions and idempotent attempts without premature promotion',()=>{
 const root=mkdtempSync(join(tmpdir(),'facts-ledger-'));const p=join(root,'facts.sqlite');
 try{expect(()=>openFactLedger(p,'readonly')).toThrow();expect(existsSync(p)).toBe(false);const l=openFactLedger(p,'readwrite');
 const fact:FactCandidate={schemaVersion:1,scope:{project:'a',environment:'local',instance:'mac',target:'memory',qualifiers:{layer:'installed'}},subject:'pi',predicate:'component.version',value:'1.0.0'};const key=factKey(fact);
 const draft={sourceId:'pkg',sourceHash:'hash',observedAt:'2026-10-27T00:00:00Z',comparisonDomain:'pkg',expiresAt:null,factKey:key,value:fact.value,collectorVersion:'1',evidenceKind:'snapshot' as const};const e=l.recordEvidence(draft);expect(e.sequence).toBe('1');expect(()=>l.recordEvidence({...draft,sequence:'1',sourceHash:'different'})).toThrow('source-equivocation');
 const r={factId:'f'.repeat(64),revision:1,fact:{...fact,evidenceRef:e.id},evidence:e,status:'accepted' as const};
 const d=l.recordAttempt({requestId:'r1',index:0,candidate:r.fact,origin:{platformSessionId:'s1',nativeSessionId:null,turnId:null,trigger:'test'},decision:{kind:'accepted',reasonCode:'verified-initial',expectedRevision:null,ruleVersion:'facts-v1',action:'create'},previous:null});
 expect(l.recordAttempt({requestId:'r1',index:0,candidate:r.fact,origin:d.origin,decision:d.decision,previous:null}).attempt).toBe(2);
 const prepared=l.prepareCommit({scope:fact.scope,files:[],revisions:[r],decisionIds:[d.id]});expect(l.current(key)).toBe(null);l.finishCommit(prepared.id);expect(l.current(key)?.revision).toBe(1);l.finishCommit(prepared.id);expect(l.allCurrent()).toHaveLength(1);l.close();
 const read=openFactLedger(p,'readonly');expect(read.current(key)?.fact.value).toBe('1.0.0');read.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
