/** Side-effect-free physical verification. Read ports never write drift state. */
import {lstatSync,readFileSync} from 'node:fs';
import type {FactRevision} from './facts-contract.js';
export const factScopeKey=(project:string|null,target:string)=>JSON.stringify([project,target]);
export interface IntegrityIssue {project:string|null;target:string;path:string;reason:string}
export function inspectFactIntegrity(revisions:FactRevision[]):{blocked:Set<string>;issues:IntegrityIssue[]} {
 const issues:IntegrityIssue[]=[],groups=new Map<string,FactRevision[]>();
 for(const r of revisions){if(!r.projectionPath){issues.push({project:r.fact.scope.project,target:r.fact.scope.target,path:'',reason:'missing-projection-location'});continue;}groups.set(r.projectionPath,[...groups.get(r.projectionPath)??[],r]);}
 for(const [path,group] of groups){let reason='';try{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('invalid-projection-file');const texts=readFileSync(path,'utf8').split('\n§\n').map(s=>s.replace(/\s*<!--\s*created=.*?-->\s*$/s,'').trim());const expected=group.map(r=>'@runtime-fact-current/v1 '+JSON.stringify({factId:r.factId,revision:r.revision,fact:r.fact}));if(expected.some(t=>!texts.includes(t))||texts.some(t=>t.includes('@runtime-fact-current')&&!expected.includes(t)))reason='projection-content-drift';}catch{reason='projection-unavailable';}if(reason)for(const r of group)issues.push({project:r.fact.scope.project,target:r.fact.scope.target,path,reason});}
 return {blocked:new Set(issues.map(i=>factScopeKey(i.project,i.target))),issues};
}
