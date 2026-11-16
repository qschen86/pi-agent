import {describe,it,expect} from 'vitest';
import {normalizeCandidate,factKey} from '../src/facts/schema.js';
import {decideFact} from '../src/facts/rules.js';
import {parseFactText} from '../src/facts/templates.js';
import type {FactCandidate,EvidenceSnapshot,RuleInput} from '../../runtime-memory/src/facts-contract.js';
const c:FactCandidate={schemaVersion:1,scope:{project:'alpha',environment:'local',instance:'mac',target:'memory',qualifiers:{layer:'installed'}},subject:'pi',predicate:'component.version',value:'1.2.3',evidenceRef:'e1'};
const e:EvidenceSnapshot={id:'e1',sourceId:'pkg',sequence:'1',sourceHash:'abc',observedAt:'2026-10-27T00:00:00Z',comparisonDomain:'pkg',expiresAt:null,factKey:factKey(c),value:c.value,collectorVersion:'1',evidenceKind:'snapshot'};
const input=(candidate=c,evidence:EvidenceSnapshot|null=e):RuleInput=>({candidate:normalizeCandidate(candidate),current:null,evidence,evaluationAt:'2026-10-27T01:00:00Z',ruleVersion:'facts-v1'});
describe('deterministic facts',()=>{
 it('replays identically and requires verified evidence even initially',()=>{const i=input();expect(decideFact(i)).toEqual(decideFact(structuredClone(i)));expect(decideFact(i).kind).toBe('accepted');expect(decideFact(input(c,null)).kind).toBe('needs_verification');});
 it('does not trust evidence self-labels or expired/mismatched snapshots',()=>{expect(decideFact(input(c,{...e,value:'9'})).kind).toBe('rejected');expect(decideFact(input(c,{...e,expiresAt:'2026-10-27T00:30:00Z'})).kind).toBe('needs_verification');});
 it('deduplicates, replaces newer evidence, rejects stale and conflicts incomparable sources',()=>{
  const current={factId:'f1',revision:1,fact:c,evidence:e,status:'accepted' as const};
  expect(decideFact({...input(),current}).kind).toBe('duplicate');
  const candidate={...c,value:'1.0.0',evidenceRef:'e2'};
  expect(decideFact({...input(candidate,{...e,id:'e2',sequence:'2',value:'1.0.0'}),current}).kind).toBe('replaced');
  expect(decideFact({...input(candidate,{...e,id:'e2',sequence:'0',value:'1.0.0'}),current}).kind).toBe('stale');
  expect(decideFact({...input(candidate,{...e,id:'e2',sourceId:'other',comparisonDomain:'other',value:'1.0.0'}),current}).kind).toBe('conflict');
 });
 it('isolates scopes and preserves typed configuration and version suffixes',()=>{expect(factKey(c)).not.toBe(factKey({...c,scope:{...c.scope,instance:'phone'}}));expect(normalizeCandidate({...c,value:'1.2.3-beta+abc'}).value).toBe('1.2.3-beta+abc');const cfg={...c,predicate:'config.value' as const,scope:{...c.scope,qualifiers:{pointer:'/enabled',layer:'desired'}}};expect(normalizeCandidate({...cfg,value:false}).value).not.toBe(normalizeCandidate({...cfg,value:'false'}).value);});
 it.each(['component.version','deployment.serving_revision','deployment.release_status','path.location','config.value'] as const)('validates %s values and qualifiers',predicate=>{expect(()=>normalizeCandidate({...c,predicate,value:{bad:1}})).toThrow();});
 it('keeps releases distinct and validates release transitions',()=>{const make=(releaseId:string,value:string)=>({...c,predicate:'deployment.release_status' as const,value,scope:{...c.scope,qualifiers:{releaseId}}});const deployed=make('old','deployed'),pending=make('new','pending');expect(factKey(deployed)).not.toBe(factKey(pending));const candidate=make('old','pending');const current={factId:'f1',revision:1,fact:deployed,evidence:{...e,factKey:factKey(deployed),value:'deployed'},status:'accepted' as const};expect(decideFact({...input(candidate,{...e,sequence:'2',factKey:factKey(candidate),value:'pending',evidenceKind:'event'}),current}).kind).toBe('rejected');});
 it('only parses an explicit one-line template and never downgrades damaged markers',()=>{expect(parseFactText('some free prose',c.scope).kind).toBe('unstructured');expect(parseFactText('@runtime-fact/v1 '+JSON.stringify(c),c.scope).kind).toBe('candidate');expect(parseFactText('@runtime-fact/v1 {bad}',c.scope).kind).toBe('rejected');expect(parseFactText('@runtime-fact/v1 '+JSON.stringify(c)+'\nmore',c.scope).kind).toBe('rejected');});
});
