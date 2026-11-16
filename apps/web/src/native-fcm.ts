import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
export class FcmFailure extends Error { constructor(readonly unregistered=false){super('FCM delivery rejected');} }
export async function sendFcm(project:string,accessToken:string,token:string,data:Record<string,string>,fetcher:typeof fetch=fetch,authorized:()=>boolean=()=>true):Promise<void>{
 if(!/^[a-z][a-z0-9-]{4,62}$/.test(project)||!authorized())throw new FcmFailure();
 const remaining=Number(data.expiresAt)-Date.now();
 if(!Number.isFinite(remaining)||remaining<=0)throw new FcmFailure();
 const response=await fetcher(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{authorization:`Bearer ${accessToken}`,'content-type':'application/json'},body:JSON.stringify({message:{token,data,android:{priority:'high',ttl:`${Math.min(604800,Math.ceil(remaining/1000))}s`,restricted_package_name:'fund.harness.piagent'}}})});
 const text=await response.text();if(text.length>65536)throw new FcmFailure();
 const result=JSON.parse(text) as {name?:string;error?:{details?:Array<{errorCode?:string}>}};
 if(!response.ok||result.error||typeof result.name!=='string'||!result.name.startsWith(`projects/${project}/messages/`)||result.name.endsWith('/'))throw new FcmFailure(result.error?.details?.some(d=>d.errorCode==='UNREGISTERED'));
}
/** A private service-account file is an operator configuration, never accepted from API input. */
export function fcmFromServiceAccount(file:string): (token:string,data:Record<string,string>,authorized:()=>boolean)=>Promise<void> {
 const credentials=JSON.parse(readFileSync(file,'utf8')) as {type?:string;project_id?:string;client_email?:string;private_key?:string;token_uri?:string};
 if(credentials.type!=='service_account'||!credentials.project_id||!/^[a-z][a-z0-9-]{4,62}$/.test(credentials.project_id)||!credentials.client_email?.endsWith('.iam.gserviceaccount.com')||!credentials.private_key?.startsWith('-----BEGIN PRIVATE KEY-----')||credentials.token_uri!=='https://oauth2.googleapis.com/token')throw new Error('FCM configuration invalid');
 const project=credentials.project_id;let cached:{token:string;until:number}|undefined;let pending:Promise<string>|undefined;
 async function access():Promise<string>{
  if(cached && cached.until>Date.now()+60000)return cached.token;
  if(pending)return pending;
  pending=(async()=>{
   const seconds=Math.floor(Date.now()/1000),encode=(j:unknown)=>Buffer.from(JSON.stringify(j)).toString('base64url');
   const unsigned=`${encode({alg:'RS256',typ:'JWT'})}.${encode({iss:credentials.client_email,scope:'https://www.googleapis.com/auth/firebase.messaging',aud:credentials.token_uri,iat:seconds,exp:seconds+3600})}`;
   const signer=createSign('RSA-SHA256');signer.update(unsigned);const assertion=`${unsigned}.${signer.sign(credentials.private_key!,'base64url')}`;
   const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion})});
   const result=await response.json() as {access_token?:string;expires_in?:number};
   if(!response.ok||!result.access_token||!Number.isFinite(result.expires_in))throw new FcmFailure();
   cached={token:result.access_token,until:Date.now()+Math.min(result.expires_in!,3600)*1000};return cached.token;
  })().finally(()=>{pending=undefined});return pending;
 }
 return async(token,data,authorized)=>{if(!authorized())throw new FcmFailure();await sendFcm(project,await access(),token,data,fetch,authorized);};
}
