import type {ApprovalLevel} from '@pi-agent/domain';
export type Provider='github'|'cloudflare';
export type Risk='read'|'write'|'destructive';
export interface Connector {id:Provider;name:string;installed:boolean;transport:'rest'}
export interface Capability {id:string;provider:Provider;title:string;risk:Risk;resourceKind:'repo'|'zone'|'account';inputSchema:Record<string,unknown>;timeoutMs:number}
export interface Connection {id:string;provider:Provider;label:string;account:string;credentialRef:string;resources:string[];status:'connected'|'disconnected'|'invalid';verifiedAt:string;revision:number}
/** Exact canonical IDs only, no implicit wildcards. */
export interface Grant {id:string;subject:string;connectionId:string;capabilities:string[];resources:string[];approval:ApprovalLevel;expiresAt?:string;revokedAt?:string}
export interface Binding {id:string;appId:string;connectionId:string;grantId:string}
export interface Execution {id:string;sessionId:string;turnId:string;connectionId:string;capabilityId:string;resource:string;state:'denied'|'pending'|'running'|'succeeded'|'failed';createdAt:string}
export interface ApprovalRequest {id:string;executionId:string;digest:string;state:'pending'|'approved'|'denied'|'expired';createdAt:string}
export interface AuditRecord {id:string;at:string;event:string;actor:string;connectionId?:string;capabilityId?:string;resource?:string;executionId?:string;outcome:string}
/** This object is created by the host, never deserialized from model arguments. */
export interface ExecutionContext {sessionId:string;turnId:string;signal?:AbortSignal;approve?:(request:{id:string;title:string;action:string;scope:string;params:unknown},signal?:AbortSignal)=>Promise<boolean>}
export class GatewayError extends Error {constructor(readonly code:string,message=code){super(message);}}
export function text(value:unknown,max=200):string{if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f]/.test(value))throw new GatewayError('INVALID_INPUT');return value.trim();}
export function onlyKeys(value:unknown,keys:string[]):asserts value is Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw new GatewayError('INVALID_INPUT');}
export function resourceId(provider:Provider,value:unknown):string{
 const raw=text(value);const pattern=provider==='github'?/^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/:/^(zone|account):[a-f0-9]{32}$/;
 if(!pattern.test(raw)||raw.includes('..'))throw new GatewayError('INVALID_RESOURCE');return raw;
}
