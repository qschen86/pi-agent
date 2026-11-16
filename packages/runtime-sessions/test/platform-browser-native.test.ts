import {it,expect} from 'vitest';
import {existsSync,mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexAppServerClient,allowlistedEnv} from '../src/codex-client.js';
import {codexBrowserConfig,verifyCodexBrowserHook} from '../src/codex-browser-config.js';
import {startPlatformBrowser} from '../src/platform-browser.js';
const binary='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
it.skipIf(!existsSync(binary))('qualifies and trusts only the platform hook and exposes the MCP tool in a real isolated Codex thread, without a model call',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'browser-codex-'));
 mkdirSync(join(dir,'codex'));
 const service=await startPlatformBrowser({sessionId:'s',turnId:'t',workspace:dir,outputDir:dir,event:()=>{}});
 const client=new CodexAppServerClient({binaryPath:binary,cwd:dir,env:allowlistedEnv({CODEX_HOME:join(dir,'codex')})});
 try{
  await client.start();const config=await codexBrowserConfig(client,service.access,dir);
  const thread=await client.request('thread/start',{cwd:dir,ephemeral:true,config}) as {thread:{id:string}};
  await verifyCodexBrowserHook(client,thread.thread.id,service.access);
  // Unsupported actions return a structured tool error, proving the native MCP bridge reached the host.
  const result=await client.request('mcpServer/tool/call',{threadId:thread.thread.id,server:'platform_browser',tool:'browser',arguments:{action:'close'}}) as {content:Array<{text:string}>;isError?:boolean};
  expect(result.isError).not.toBe(true);expect(result.content[0].text).toContain('"ok":true');
 }finally{client.stop();await service.dispose();rmSync(dir,{recursive:true,force:true});}
},30000);
it.skipIf(!existsSync('/opt/homebrew/bin/pi'))('real Pi exposes and executes the platform tool using a synthetic local provider',async()=>{
 const {createServer}=await import('node:http');const {randomUUID}=await import('node:crypto');const {writeFileSync}=await import('node:fs');const {PiRuntimeSupervisor}=await import('../../pi-runtime/src/supervisor.js');
 const root=mkdtempSync(join(tmpdir(),'browser-pi-')),workspace=join(root,'work'),source=join(root,'source');mkdirSync(workspace);mkdirSync(source);
 let tools:string[]=[],toolResult='';
 const provider=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);tools=(body.tools??[]).map((t:any)=>t.function.name);const result=body.messages.findLast((m:any)=>m.role==='tool');if(result)toolResult=JSON.stringify(result);
 const delta=result?{role:'assistant',content:'platform browser done'}:{role:'assistant',tool_calls:[{index:0,id:'platform_fixture',type:'function',function:{name:'platform_browser',arguments:'{"action":"close"}'}}]};
 res.writeHead(200,{'content-type':'text/event-stream'});for(const [d,finish] of [[delta,null],[{},result?'stop':'tool_calls']])res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'probe',choices:[{index:0,delta:d,finish_reason:finish}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\n');res.end('data: [DONE]\n\n');});
 await new Promise<void>(yes=>provider.listen(0,'127.0.0.1',yes));
 writeFileSync(join(source,'settings.json'),'{}');writeFileSync(join(source,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`,api:'openai-completions',apiKey:'synthetic-only',models:[{id:'probe',name:'probe',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1024}]}}}));
 const tool=await startPlatformBrowser({sessionId:'pi',turnId:'t',workspace,outputDir:workspace,event:()=>{}}),runtime=new PiRuntimeSupervisor();let timer:NodeJS.Timeout|undefined;
 try{
  const done=new Promise<void>((yes,no)=>{timer=setTimeout(()=>no(new Error('Pi fixture timed out')),20000);runtime.on('event',(e:any)=>{if(e.type==='runtime_error')no(new Error(e.error));if(e.type==='message_end'&&JSON.stringify(e.message).includes('platform browser done'))yes();});});
  await runtime.start({version:1,binary:'/opt/homebrew/bin/pi',workspace,provider:'fixture',model:'probe',mode:'pi-native',sessionId:randomUUID(),sourceAgentDir:source,platformBrowser:tool.access});
  runtime.send({type:'prompt',id:'fixture',message:'use platform browser fixture'});await done;expect(tools).toContain('platform_browser');expect(toolResult).toContain('ok');expect(toolResult).not.toContain('isError":true');
 }finally{clearTimeout(timer);await runtime.stop();await tool.dispose();provider.closeAllConnections();await new Promise<void>(yes=>provider.close(()=>yes()));rmSync(root,{recursive:true,force:true});}
},30000);
