import type {FactScope,FactCandidate,FactRevision} from '../../../runtime-memory/src/facts-contract.js';
import {normalizeCandidate,sameScope} from './schema.js';
export const FACT_TEMPLATE='@runtime-fact/v1 ';
export const FACT_MARKER='@runtime-fact-current/v1 ';
export function parseFactText(text:string,scope:FactScope):{kind:'candidate';candidate:FactCandidate}|{kind:'needs_verification'|'unstructured'|'rejected';reasonCode:string} {
 if(!text.includes('@runtime-fact'))return {kind:'unstructured',reasonCode:'outside-structured-domain'};
 try{if(!text.startsWith(FACT_TEMPLATE)||text.includes('\n'))throw new Error();const candidate=normalizeCandidate(JSON.parse(text.slice(FACT_TEMPLATE.length)));if(!sameScope(candidate.scope,scope))return {kind:'needs_verification',reasonCode:'scope-mismatch'};return {kind:'candidate',candidate};}catch{return {kind:'rejected',reasonCode:'invalid-structured-template'};}
}
export function renderFact(r:FactRevision):string{return FACT_MARKER+JSON.stringify({factId:r.factId,revision:r.revision,fact:r.fact});}
export function readFactMarker(text:string):{factId:string;revision:number;fact:FactCandidate}|null {
 const start=text.indexOf(FACT_MARKER);if(start<0)return null;
 const raw=JSON.parse(text.slice(start+FACT_MARKER.length));if(!/^[a-f0-9]{64}$/.test(raw.factId)||!Number.isSafeInteger(raw.revision)||raw.revision<1)throw new Error('invalid-fact-marker');return {...raw,fact:normalizeCandidate(raw.fact)};
}
