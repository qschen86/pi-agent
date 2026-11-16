import type {CodexAppServerClient} from './codex-client.js';
import type {BrowserAccess} from './platform-browser.js';
/** Trust only the platform command's exact native hash; never bypass trust for user/plugin hooks. */
export async function codexBrowserConfig(client:CodexAppServerClient,access:BrowserAccess,cwd:string):Promise<Record<string,unknown>> {
 const command=[process.execPath,access.hookPath].map(x=>"'"+x.replaceAll("'", "'\"'\"'")+"'").join(' ');
 const config:Record<string,unknown>={'features.hooks':true,'hooks.PreToolUse':[{hooks:[{type:'command',command,timeout:10}]}], 'mcp_servers.platform_browser':{command:process.execPath,args:[access.bridgePath,access.socketPath],startup_timeout_sec:15,tool_timeout_sec:70}};
 // Ephemeral preflight has no user input, model call or durable native-session binding.
 const probe=await client.request('thread/start',{cwd,ephemeral:true,config}) as {thread:{id:string}};
 try {
  const list=await client.request('hooks/list',{threadId:probe.thread.id}) as {data?:Array<{hooks?:Array<{key:string;command?:string;eventName:string;currentHash:string;source:string;enabled:boolean}>;errors?:unknown[]}>};
  const hooks=list.data?.flatMap(x=>x.hooks??[])??[];
  const hook=hooks.find(h=>h.command===command&&h.eventName==='preToolUse'&&h.source==='sessionFlags'&&h.enabled);
  if(!hook||!/^sha256:[a-f0-9]{64}$/.test(hook.currentHash)||list.data?.some(x=>x.errors?.length))throw new Error('Codex screenshot hook qualification failed');
  config['hooks.state']={[hook.key]:{trusted_hash:hook.currentHash}};
  return config;
 }finally{await client.request('thread/unsubscribe',{threadId:probe.thread.id},10000).catch(()=>{});}
}
export async function verifyCodexBrowserHook(client:CodexAppServerClient,threadId:string,access:BrowserAccess):Promise<void>{
 const list=await client.request('hooks/list',{threadId}) as {data?:Array<{hooks?:Array<{command?:string;eventName:string;enabled:boolean;trustStatus:string}>;errors?:unknown[]}>};
 if(!list.data?.some(x=>x.hooks?.some(h=>h.command?.includes(access.hookPath)&&h.eventName==='preToolUse'&&h.enabled&&h.trustStatus==='trusted'))||list.data.some(x=>x.errors?.length))throw new Error('Codex screenshot hook is not enabled and trusted; input not dispatched');
}
