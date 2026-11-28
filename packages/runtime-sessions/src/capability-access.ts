/** The host binds session+turn to a private socket. Model arguments cannot choose identity. */
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {serveJSON} from '@pi-agent/broker-transport';
import type {CapabilityGateway,ExecutionContext} from '@pi-agent/capability-gateway';
export interface CapabilityAccess {socketPath:string;bridgePath:string}
export async function startCapabilityAccess(gateway:CapabilityGateway,context:ExecutionContext){
 const root=mkdtempSync(join(tmpdir(),'cg-')),abort=new AbortController();
 const server=await serveJSON(join(root,'g.sock'),(req,signal)=>gateway.dispatch({...context,signal:AbortSignal.any([abort.signal,signal])},req),{timeoutMs:15*60*1000});
 return {access:{socketPath:server.socketPath,bridgePath:fileURLToPath(new URL('../../pi-runtime/src/capability-mcp.mjs',import.meta.url))},dispose:async()=>{abort.abort();await server.close();rmSync(root,{recursive:true,force:true});}};
}
