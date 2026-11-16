import {readFile,realpath,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {EvidenceDraft,FactValue} from '../../../runtime-memory/src/facts-contract.js';
import {boundedSource,type EvidencePolicy} from './evidence-policy.js';
import {normalizeCandidate,factKey} from './schema.js';
export interface CollectionRequest {collectorId:string;subjectId:string}
const sensitive=/(?:secret|password|token|credential|api.?key|auth)/i;
function pointer(value:unknown,p:string):unknown {if(!p.startsWith('/')||sensitive.test(p))throw new Error('sensitive-or-invalid-pointer');return p.slice(1).split('/').reduce<unknown>((v,k)=>{k=k.replace(/~1/g,'/').replace(/~0/g,'~');if(['__proto__','constructor','prototype'].includes(k)||!v||typeof v!=='object'||!Object.hasOwn(v,k))throw new Error('missing-config-field');return (v as Record<string,unknown>)[k];},value);}
export async function collectEvidence(request:CollectionRequest,policy:EvidencePolicy,transport:typeof fetch=fetch):Promise<EvidenceDraft> {
 if(Object.keys(request).some(k=>!['collectorId','subjectId'].includes(k)))throw new Error('invalid-collection-request');
 const matches=policy.sources.filter(s=>s.collectorId===request.collectorId&&s.subjectId===request.subjectId);
 if(!policy.enabled||matches.length!==1)throw new Error('unknown-collector');const s=matches[0]!;
 let value:unknown,sequence:string|undefined,kind:EvidenceDraft['evidenceKind']='snapshot';const now=new Date();
 if(s.collectorId==='serving'){
  const u=new URL(s.url!);if(u.protocol!=='https:'||u.username||u.password)throw new Error('invalid-serving-origin');
  const response=await transport(u,{redirect:'error',signal:AbortSignal.timeout(5000)});if(response.status!==200||response.redirected)throw new Error('serving-unavailable');
  const reader=response.body?.getReader();if(!reader)throw new Error('empty-serving-body');let bytes=0,raw='';const decoder=new TextDecoder();try{for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>16384)throw new Error('serving-too-large');raw+=decoder.decode(chunk.value,{stream:true});}}finally{await reader.cancel();}
  const body=JSON.parse(raw);if(body.phase!=='ready'||body.slot!==s.fact.scope.qualifiers.slot||typeof body.sha!=='string')throw new Error('unverified-serving-identity');value=body.sha;
 }else{
  if(!s.file||!s.root)throw new Error('missing-source-file');const file=boundedSource(s.file,s.root);if((await stat(file)).size>1024*1024)throw new Error('source-too-large');
  if(s.collectorId==='path')value=s.fact.scope.qualifiers.layer==='resolved'?await realpath(file):file;
  else{const body=JSON.parse(await readFile(file,'utf8'));if(s.collectorId==='json'){if(sensitive.test(s.pointer??''))throw new Error('sensitive-pointer');if(s.fact.predicate==='config.value'&&s.pointer!==s.fact.scope.qualifiers.pointer)throw new Error('config-pointer-mismatch');value=pointer(body,s.pointer!);}
   else{if(body.version!==1||body.releaseId!==s.fact.scope.qualifiers.releaseId||body.service!==s.fact.subject||body.environment!==s.fact.scope.environment||body.instance!==s.fact.scope.instance||!/^\d+$/.test(body.sequence)||!Number.isFinite(Date.parse(body.occurredAt)))throw new Error('invalid-release-event');value=body.status;sequence=body.sequence;kind='event';now.setTime(Date.parse(body.occurredAt));}}
 }
 const fact=normalizeCandidate({...s.fact,value});const terminal=kind==='event'&&['deployed','failed','rolled_back'].includes(String(value));const max=s.fact.predicate.startsWith('deployment.')?300:86400;
 return {sourceId:s.id,...(sequence===undefined?{}:{sequence}),sourceHash:createHash('sha256').update(JSON.stringify([factKey(fact),value,kind,sequence??null])).digest('hex'),observedAt:now.toISOString(),comparisonDomain:s.id,expiresAt:terminal?null:new Date(now.getTime()+Math.min(s.ttlSeconds??max,max)*1000).toISOString(),factKey:factKey(fact),value:value as FactValue,collectorVersion:'1',evidenceKind:kind};
}
