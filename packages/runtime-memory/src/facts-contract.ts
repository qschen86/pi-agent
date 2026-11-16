/** Structured fact wire types. No IO or model dependencies. */
export type FactValue=string|number|boolean|null;
export type Predicate='component.version'|'deployment.serving_revision'|'deployment.release_status'|'path.location'|'config.value';
export interface FactScope {project:string|null;environment:string;instance:string;target:'memory'|'user'|'failure';qualifiers:Record<string,string>}
export interface FactOrigin {platformSessionId:string|null;nativeSessionId:string|null;turnId:string|null;trigger:string;tool?:string}
export interface FactCandidate {schemaVersion:1;scope:FactScope;subject:string;predicate:Predicate;value:FactValue;evidenceRef?:string}
export type NormalizedFact=FactCandidate;
export interface EvidenceSnapshot {id:string;sourceId:string;sequence:string;sourceHash:string;observedAt:string;comparisonDomain:string;expiresAt:string|null;factKey:string;value:FactValue;collectorVersion:string;evidenceKind:'snapshot'|'event'|'revocation'}
export type EvidenceDraft=Omit<EvidenceSnapshot,'id'|'sequence'> & {sequence?:string};
export interface FactRevision {projectionPath?:string;factId:string;revision:number;fact:NormalizedFact;evidence:EvidenceSnapshot;status:'accepted'|'superseded'}
export const decisionKinds=['accepted','replaced','duplicate','stale','conflict','rejected','needs_verification','unstructured'] as const;
export type DecisionKind=typeof decisionKinds[number];
export interface Decision {kind:DecisionKind;reasonCode:string;ruleVersion:'facts-v1';expectedRevision:number|null;action:'none'|'create'|'replace'}
export interface RuleInput {candidate:NormalizedFact;current:FactRevision|null;evidence:EvidenceSnapshot|null;evaluationAt:string;ruleVersion:'facts-v1'}
export type CommitState='prepared'|'published'|'committed'|'failed'|'recovery_required';
export interface RecordedDecision {project:string|null;seq:number;id:string;requestId:string;index:number;candidate:FactCandidate|null;evidence:EvidenceSnapshot|null;rawHash:string;origin:FactOrigin;at:string;decision:Decision;previous:FactRevision|null;commitId:string|null;state:string;attempt:number}
export interface FactAuditQuery {project:string|null;includeGlobal?:boolean;sessionId?:string;from?:string;to?:string;decision?:DecisionKind;before?:string;limit?:number}
export interface FactAuditPage {version:1;sourceId:string;ledgerIdentity:string;items:RecordedDecision[];nextCursor:string|null;hasMore:boolean;supported:boolean;health:'ready'|'degraded'|'not-initialized'|'unsupported'}
export const defaultFactOrigin=():FactOrigin=>({platformSessionId:null,nativeSessionId:null,turnId:null,trigger:'unknown'});
