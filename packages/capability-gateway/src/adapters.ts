import {GatewayError,resourceId,type Provider,type Capability} from './contracts.js';
export interface PreparedCall {method:'GET'|'POST'|'PATCH';url:string;body?:Record<string,unknown>;form?:Record<string,string>}
const gh='https://api.github.com',cf='https://api.cloudflare.com/client/v4';
export function prepareCall(cap:Capability,resource:string,input:Record<string,unknown>):PreparedCall{
 resourceId(cap.provider,resource);if(!resource.startsWith(cap.resourceKind+':'))throw new GatewayError('INVALID_RESOURCE');
 const id=resource.slice(resource.indexOf(':')+1),parts=cap.id.split('.'),kind=parts[1],action=parts[2];
 if(cap.provider==='github'){
  const root=gh+'/repos/'+id.split('/').map(encodeURIComponent).join('/');
  const suffix:Record<string,string>={repo:'',pr:'/pulls',issue:'/issues',workflow:'/actions/runs',release:'/releases'};
  if(!(kind in suffix))throw new GatewayError('UNKNOWN_CAPABILITY');
  return {method:action==='read'?'GET':'POST',url:root+suffix[kind]+(kind!=='repo'&&action==='read'?'?per_page=30':''),...(action!=='read'?{body:input}:{})};
 }
 const base=cf+(cap.resourceKind==='zone'?'/zones/':'/accounts/')+id;
 if(kind==='zone'&&action==='read')return {method:'GET',url:base};
 if(kind==='dns'&&action==='read')return {method:'GET',url:base+'/dns_records?per_page=30'};
 if(kind==='dns'&&action==='update'){const {recordId,...body}=input;return {method:'PATCH',url:base+'/dns_records/'+encodeURIComponent(String(recordId)),body};}
 if(kind==='workers'&&action==='read')return {method:'GET',url:base+'/workers/scripts'};
 if(kind==='pages'&&action==='read')return {method:'GET',url:base+'/pages/projects'};
 if(kind==='deployment')return {method:action==='read'?'GET':'POST',url:base+'/pages/projects/'+encodeURIComponent(String(input.project))+'/deployments',...(action==='create'?{form:{branch:String(input.branch)}}:{})};
 throw new GatewayError('UNKNOWN_CAPABILITY');
}
/** Fixed origins, no redirects, no automatic write retries, and bounded streaming reads. */
export class RestAdapters {
 constructor(private fetcher:typeof fetch=fetch){}
 async request(provider:Provider,token:string,call:PreparedCall,signal?:AbortSignal):Promise<unknown>{
  const u=new URL(call.url);if(u.origin!==(provider==='github'?gh:'https://api.cloudflare.com')||u.username||u.password)throw new GatewayError('UNSAFE_UPSTREAM');
  const headers:Record<string,string>={Authorization:'Bearer '+token,Accept:'application/json','User-Agent':'pi-agent-capability/1'};
  if(provider==='github')headers['X-GitHub-Api-Version']='2022-11-28';
  let body:string|FormData|undefined;if(call.body){headers['Content-Type']='application/json';body=JSON.stringify(call.body);}else if(call.form){const form=new FormData();for(const [k,v]of Object.entries(call.form))form.append(k,v);body=form;}
  let res:Response;try{res=await this.fetcher(call.url,{method:call.method,headers,body,redirect:'error',signal});}catch{throw new GatewayError(signal?.aborted?'TIMEOUT':'UPSTREAM_UNAVAILABLE');}
  if(!res.ok){await res.body?.cancel();throw new GatewayError(res.status===401||res.status===403?'AUTH_FAILED':res.status===429?'RATE_LIMITED':'UPSTREAM_FAILED');}
  const reader=res.body?.getReader();let total=0;const chunks:Uint8Array[]=[];
  if(reader)try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>240*1024)throw new GatewayError('RESULT_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  let data:unknown;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new GatewayError('INVALID_UPSTREAM');}
  if(provider==='cloudflare'){const envelope=data as {success?:boolean;result?:unknown};if(envelope.success!==true)throw new GatewayError('UPSTREAM_FAILED');return envelope.result;}
  return data;
 }
 async verify(provider:Provider,token:string,resources:string[],signal?:AbortSignal):Promise<string>{
  let account:string;
  if(provider==='github'){const user=await this.request(provider,token,{method:'GET',url:gh+'/user'},signal) as {login?:unknown};if(typeof user.login!=='string')throw new GatewayError('AUTH_FAILED');account=user.login;}
  else {const verification=await this.request(provider,token,{method:'GET',url:cf+'/user/tokens/verify'},signal) as {status?:string;id?:string};if(verification.status!=='active')throw new GatewayError('AUTH_FAILED');account=verification.id??'Cloudflare';}
  for(const resource of resources){resourceId(provider,resource);const [kind,id]=resource.split(':');await this.request(provider,token,{method:'GET',url:provider==='github'?gh+'/repos/'+id:cf+'/'+(kind==='zone'?'zones/':'accounts/')+id},signal);}
  return account;
 }
}
