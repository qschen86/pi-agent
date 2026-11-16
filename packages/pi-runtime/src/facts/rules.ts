import type {RuleInput,Decision,DecisionKind} from '../../../runtime-memory/src/facts-contract.js';
import {factKey} from './schema.js';
const transitions:Record<string,string[]>={pending:['running'],running:['verified','failed'],verified:['deployed','failed'],deployed:['rolled_back'],failed:[],rolled_back:[]};
export function decideFact(i:RuleInput):Decision {
 const {candidate:c,current:old,evidence:e}=i;
 const out=(kind:DecisionKind,reasonCode:string):Decision=>({kind,reasonCode,ruleVersion:i.ruleVersion,expectedRevision:old?.revision??null,action:kind==='accepted'?'create':kind==='replaced'?'replace':'none'});
 if(!e)return out('needs_verification','missing-evidence');
 if(e.id!==c.evidenceRef||e.factKey!==factKey(c)||e.value!==c.value||!/^(0|[1-9]\d*)$/.test(e.sequence)||!e.sourceId||!e.comparisonDomain||!Number.isFinite(Date.parse(e.observedAt))||!Number.isFinite(Date.parse(i.evaluationAt)))return out('rejected','evidence-mismatch');
 if(Date.parse(e.observedAt)>Date.parse(i.evaluationAt))return out('rejected','future-evidence');
 if(e.expiresAt!==null&&(!Number.isFinite(Date.parse(e.expiresAt))||Date.parse(e.expiresAt)<=Date.parse(i.evaluationAt)))return out('needs_verification','expired-evidence');
 if(!old)return out('accepted','verified-initial');
 if(factKey(old.fact)!==factKey(c))return out('rejected','identity-mismatch');
 if(old.fact.value===c.value)return out('duplicate','same-value');
 if(e.sourceId!==old.evidence.sourceId||e.comparisonDomain!==old.evidence.comparisonDomain)return out('conflict','incomparable-sources');
 if(e.evidenceKind==='snapshot'&&old.evidence.evidenceKind==='snapshot'&&Date.parse(e.observedAt)<Date.parse(old.evidence.observedAt))return out('stale','older-snapshot');
 if(BigInt(e.sequence)<BigInt(old.evidence.sequence))return out('stale','older-observation');
 if(BigInt(e.sequence)===BigInt(old.evidence.sequence))return out('conflict','same-sequence-different-value');
 if(c.predicate==='deployment.release_status'&&e.evidenceKind!=='snapshot'&&!transitions[String(old.fact.value)]?.includes(String(c.value)))return out('rejected','invalid-release-transition');
 return out('replaced','newer-verified-observation');
}
