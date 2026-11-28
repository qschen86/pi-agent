import {it,expect} from 'vitest';
import {existsSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GatewayStore,CapabilityGateway,FileVault} from '@pi-agent/capability-gateway';
import {startCapabilityAccess} from '../src/capability-access.js';
it('stdio bridge preserves Chinese UTF-8 split across socket chunks',async()=>{
 const {createServer}=await import('node:net'),{spawn}=await import('node:child_process'),{fileURLToPath}=await import('node:url');
 const root=mkdtempSync(join(tmpdir(),'cg-utf8-')),socketPath=join(root,'g.sock');
 const payload=Buffer.from(JSON.stringify({ok:true,result:'中文能力资料'})+'\n'),split=payload.indexOf(Buffer.from('中'))+1;
 const server=createServer(socket=>socket.once('data',()=>{socket.write(payload.subarray(0,split));setTimeout(()=>socket.end(payload.subarray(split)),20);}));
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../../pi-runtime/src/capability-mcp.mjs',import.meta.url)),socketPath],{stdio:['pipe','pipe','pipe']});let output='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{output+=chunk;});
 try{
  const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'capability_search',arguments:{}}})+'\n');
  expect(await exited).toBe(0);expect(JSON.parse(JSON.parse(output).result.content[0].text)).toEqual({ok:true,result:'中文能力资料'});
 }finally{child.kill();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});}
},5000);
it.skipIf(!existsSync('/opt/homebrew/bin/pi'))('real Pi exposes and invokes capability tools using a synthetic local provider',async()=>{
 const {createServer}=await import('node:http');const {randomUUID}=await import('node:crypto');const {writeFileSync}=await import('node:fs');const {PiRuntimeSupervisor}=await import('../../pi-runtime/src/supervisor.js');
 const root=mkdtempSync(join(tmpdir(),'browser-pi-')),workspace=join(root,'work'),source=join(root,'source');mkdirSync(workspace);mkdirSync(source);
 let tools:string[]=[],toolResult='';
 const provider=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);tools=(body.tools??[]).map((t:any)=>t.function.name);const result=body.messages.findLast((m:any)=>m.role==='tool');if(result)toolResult=JSON.stringify(result);
 const delta=result?{role:'assistant',content:'platform browser done'}:{role:'assistant',tool_calls:[{index:0,id:'platform_fixture',type:'function',function:{name:'capability_search',arguments:'{}'}}]};
 res.writeHead(200,{'content-type':'text/event-stream'});for(const [d,finish] of [[delta,null],[{},result?'stop':'tool_calls']])res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'probe',choices:[{index:0,delta:d,finish_reason:finish}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\n');res.end('data: [DONE]\n\n');});
 await new Promise<void>(yes=>provider.listen(0,'127.0.0.1',yes));
 writeFileSync(join(source,'settings.json'),'{}');writeFileSync(join(source,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`,api:'openai-completions',apiKey:'synthetic-only',models:[{id:'probe',name:'probe',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1024}]}}}));
 const store=new GatewayStore(join(root,'gateway.sqlite'));const gateway=new CapabilityGateway(store,new FileVault(join(root,'vault')));const tool=await startCapabilityAccess(gateway,{sessionId:'pi',turnId:'t'}),runtime=new PiRuntimeSupervisor();let timer:NodeJS.Timeout|undefined;
 try{
  const done=new Promise<void>((yes,no)=>{timer=setTimeout(()=>no(new Error('Pi fixture timed out')),20000);runtime.on('event',(e:any)=>{if(e.type==='runtime_error')no(new Error(e.error));if(e.type==='message_end'&&JSON.stringify(e.message).includes('platform browser done'))yes();});});
  await runtime.start({version:1,binary:'/opt/homebrew/bin/pi',workspace,provider:'fixture',model:'probe',mode:'pi-native',sessionId:randomUUID(),sourceAgentDir:source,capabilityGateway:tool.access});
  runtime.send({type:'prompt',id:'fixture',message:'use platform browser fixture'});await done;expect(tools).toContain('capability_search');expect(toolResult).toContain('ok');expect(toolResult).not.toContain('isError":true');
 }finally{clearTimeout(timer);await runtime.stop();await tool.dispose();store.close();provider.closeAllConnections();await new Promise<void>(yes=>provider.close(()=>yes()));rmSync(root,{recursive:true,force:true});}
},30000);
it.skipIf(!existsSync('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'))('real isolated Codex discovers and invokes the gateway MCP without a model call',async()=>{
 const {CodexAppServerClient,allowlistedEnv}=await import('../src/codex-client.js');const root=mkdtempSync(join(tmpdir(),'capability-codex-'));mkdirSync(join(root,'home'));
 const store=new GatewayStore(join(root,'gateway.sqlite')),gateway=new CapabilityGateway(store,new FileVault(join(root,'vault'))),tool=await startCapabilityAccess(gateway,{sessionId:'codex-probe',turnId:'t'});
 const client=new CodexAppServerClient({binaryPath:'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',cwd:root,env:allowlistedEnv({CODEX_HOME:join(root,'home')})});
 try{await client.start();const thread=await client.request('thread/start',{cwd:root,ephemeral:false,config:{'mcp_servers.capability_gateway':{command:process.execPath,args:[tool.access.bridgePath,tool.access.socketPath],startup_timeout_sec:15}}}) as {thread:{id:string}};
 const result=await client.request('mcpServer/tool/call',{threadId:thread.thread.id,server:'capability_gateway',tool:'capability_search',arguments:{}}) as {content:Array<{text:string}>;isError?:boolean};expect(result.isError).not.toBe(true);expect(JSON.parse(result.content[0].text)).toEqual({ok:true,result:[]});
 await client.request('thread/archive',{threadId:thread.thread.id});
 await client.request('thread/unarchive',{threadId:thread.thread.id});
 await tool.dispose();
 store.put('connections',{id:'probe',provider:'github',label:'fixture',account:'fixture',credentialRef:'unused',resources:['repo:a/b'],status:'connected',verifiedAt:new Date().toISOString(),revision:1});
 gateway.grant({subject:'codex-next',connectionId:'probe',capabilities:['github.repo.read'],resources:['repo:a/b'],approval:'AUTO'},'owner');
 const next=await startCapabilityAccess(gateway,{sessionId:'codex-next',turnId:'t2'});
 try{
 await client.request('thread/resume',{threadId:thread.thread.id,cwd:root,excludeTurns:true,config:{'mcp_servers.capability_gateway':{command:process.execPath,args:[next.access.bridgePath,next.access.socketPath],startup_timeout_sec:15}}});
 const resumed=await client.request('mcpServer/tool/call',{threadId:thread.thread.id,server:'capability_gateway',tool:'capability_search',arguments:{}}) as {content:Array<{text:string}>;isError?:boolean};expect(resumed.isError).not.toBe(true);expect(JSON.parse(resumed.content[0].text).result).toHaveLength(1);
 }finally{await next.dispose();}

 }finally{const exited=client.alive?new Promise<void>(resolve=>client.once('exit',()=>resolve())):Promise.resolve();client.stop();await exited;await tool.dispose();store.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
},30000);
