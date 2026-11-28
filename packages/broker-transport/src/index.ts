/** Host-only bounded JSON-lines transport. Business budgets and ledgers stay in callers. */
import {createServer, type Socket} from 'node:net';
import {chmodSync, unlinkSync} from 'node:fs';
export class TransportError extends Error {constructor(readonly code:string){super(code);}}
export function object(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new TransportError('INVALID_INPUT');
 return value as Record<string,unknown>;
}
export function boundedJSON(value:unknown,maxBytes=256*1024):string{
 const text=JSON.stringify(value);if(typeof text!=='string'||Buffer.byteLength(text)>maxBytes)throw new TransportError('RESULT_TOO_LARGE');return text;
}
export async function serveJSON(socketPath:string,handle:(value:unknown,signal:AbortSignal)=>Promise<unknown>,options:{maxRequestBytes?:number;maxResponseBytes?:number;timeoutMs?:number}={}){
 const clients=new Set<Socket>();let closed=false;
 const server=createServer(s=>{
  clients.add(s);const abort=new AbortController();s.setEncoding('utf8');let buffer='',busy=false;
  const error=(code:string)=>{if(!s.destroyed)s.end(JSON.stringify({ok:false,code,text:code})+'\n');};
  s.setTimeout(options.timeoutMs??120000,()=>s.destroy());
  s.on('close',()=>{abort.abort();clients.delete(s);});s.on('error',()=>{});
  s.on('data',(c:string)=>{
   if(busy)return;buffer+=c;
   if(Buffer.byteLength(buffer)>(options.maxRequestBytes??65536)){error('INVALID_INPUT');return;}
   if(!buffer.includes('\n'))return;busy=true;
   void(async()=>{try{
    const req=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));object(req);
    const result=await handle(req,abort.signal);if(!closed&&!s.destroyed)s.end(boundedJSON(result,options.maxResponseBytes)+'\n');
   }catch(e){error(e instanceof TransportError?e.code:'INTERNAL_ERROR');}})();
  });
 });
 await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(socketPath,()=>yes());});chmodSync(socketPath,0o600);
 return {socketPath,close:async()=>{if(closed)return;closed=true;for(const s of clients)s.destroy();await new Promise<void>(r=>server.close(()=>r()));try{unlinkSync(socketPath);}catch{}}};
}
