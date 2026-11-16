import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import type {FactCandidate,NormalizedFact,Predicate,FactScope} from '../../../runtime-memory/src/facts-contract.js';
const predicates:Predicate[]=['component.version','deployment.serving_revision','deployment.release_status','path.location','config.value'];
const text=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=512&&!/[\r\n\0]/.test(v);
export function normalizeCandidate(input:unknown):NormalizedFact {
 if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('invalid-candidate');
 const c=input as FactCandidate,s=c.scope;
 if(Buffer.byteLength(JSON.stringify(input))>16384)throw new Error('candidate-too-large');
 if(Object.keys(c).some(k=>!['schemaVersion','scope','subject','predicate','value','evidenceRef'].includes(k))||c.schemaVersion!==1||!text(c.subject)||!predicates.includes(c.predicate)||!s||Object.keys(s).some(k=>!['project','environment','instance','target','qualifiers'].includes(k))||!(s.project===null||text(s.project))||!text(s.environment)||!text(s.instance)||!['memory','user','failure'].includes(s.target)||!s.qualifiers||Array.isArray(s.qualifiers)||Object.entries(s.qualifiers).some(([k,v])=>!text(k)||!text(v))||Object.keys(s.qualifiers).length>10)throw new Error('invalid-fact-scope');
 if(!(c.value===null||['string','boolean'].includes(typeof c.value)||typeof c.value==='number'&&Number.isFinite(c.value)))throw new Error('invalid-fact-value');
 if(c.evidenceRef!==undefined&&!text(c.evidenceRef))throw new Error('invalid-evidence-ref');
 const q=s.qualifiers;
 const allowed:Record<Predicate,string[]>={'component.version':['layer'],'deployment.serving_revision':['slot'],'deployment.release_status':['releaseId'],'path.location':['layer'],'config.value':['layer','pointer']};
 if(Object.keys(q).some(k=>!allowed[c.predicate].includes(k))||allowed[c.predicate].some(k=>!text(q[k])))throw new Error('missing-fact-qualifier');
 if(c.predicate==='component.version'&&(!['declared','installed','running'].includes(q.layer!)||typeof c.value!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(c.value)))throw new Error('invalid-version');
 if(c.predicate==='deployment.serving_revision'&&(typeof c.value!=='string'||!(/^[a-f0-9]{40}$/.test(c.value)||/^[a-f0-9]{64}$/.test(c.value))))throw new Error('ambiguous-serving-revision');
 if(c.predicate==='deployment.release_status'&&!['pending','running','verified','deployed','failed','rolled_back'].includes(String(c.value)))throw new Error('invalid-release-status');
 if(c.predicate==='path.location'&&(!['declared','resolved'].includes(q.layer!)||typeof c.value!=='string'||!isAbsolute(c.value)||c.value.includes('\0')))throw new Error('invalid-path');
 if(c.predicate==='config.value'&&(!['desired','effective'].includes(q.layer!)||!q.pointer!.startsWith('/')))throw new Error('invalid-config-field');
 return {...c,scope:{...s,qualifiers:Object.fromEntries(Object.entries(q).sort(([a],[b])=>a.localeCompare(b,'en')))}};
}
export function factKey(c:FactCandidate):string {const s=c.scope;return JSON.stringify([s.project,s.environment,s.instance,s.target,c.subject,c.predicate,Object.entries(s.qualifiers).sort(([a],[b])=>a.localeCompare(b,'en'))]);}
export const factId=(c:FactCandidate)=>createHash('sha256').update(factKey(c)).digest('hex');
export const sameScope=(a:FactScope,b:FactScope)=>a.project===b.project&&a.environment===b.environment&&a.instance===b.instance&&a.target===b.target;
