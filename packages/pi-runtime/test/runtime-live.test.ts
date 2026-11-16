/** Direct terminal process: no platform driver/server imports. Opt-in native Seatbelt tests. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
const modules=process.env.PI_COMMUNITY_MODULES, executable=process.env.PI_RUNTIME_TEST_EXECUTABLE;
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0))await fn();});
describe.skipIf(!modules||process.platform!=='darwin')('standalone runtime terminal',()=>{
  it.each([true,false])('owns terminal approval and durable history, then resumes through standalone RPC (%s)',async approved=>{
    const root=mkdtempSync('/private/tmp/prt-cli-'),workspace=join(root,'workspace'),source=join(root,'source'),state=join(root,'state');
    mkdirSync(workspace);mkdirSync(source);
    const requests:any[]=[];
    const server=createServer(async(req,res)=>{
      let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);requests.push(body);
      const hasResult=body.messages.some((m:any)=>m.role==='tool');
      const delta=hasResult?{role:'assistant',content:'terminal runtime verified'}:{role:'assistant',tool_calls:[{index:0,id:'terminal_write',type:'function',function:{name:'write',arguments:JSON.stringify({path:'terminal.txt',content:'persisted'})}}]};
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const [d,finish]of [[delta,null],[{},hasResult?'stop':'tool_calls']])res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'probe',choices:[{index:0,delta:d,finish_reason:finish}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
    writeFileSync(join(source,'settings.json'),'{}');
    writeFileSync(join(source,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${(server.address() as any).port}/v1`,api:'openai-completions',apiKey:'fixture-only',models:[{id:'probe',name:'probe',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1024}]}}}));
    const profile=join(root,'profile.json');writeFileSync(profile,JSON.stringify({version:1,permissionPackage:join(modules!,'@gotgenes/pi-permission-system')}));
    cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});});
    async function run(extra:string[]=[]){
      const command=executable??process.execPath,base=executable?[]:[fileURLToPath(new URL('../bin/pi-runtime.mjs',import.meta.url))];
      const child=spawn(command,[...base,'--profile',profile,'--cwd',workspace,'--state-dir',state,'--pi-binary','/opt/homebrew/bin/pi','--provider','fixture','--model','probe','--prompt','run terminal fixture',...extra],{cwd:'/private/tmp',env:{...process.env,PI_CODING_AGENT_DIR:source},stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='',answers=0;
      child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>{stderr+=c;if(stderr.includes('Choose (empty cancels): ')&&answers===0){answers++;const choices=[...stderr.matchAll(/^(\d+)\. (.+)$/gm)];const choice=choices.find(m=>approved?/^yes/i.test(m[2]):/^no/i.test(m[2]));if(!choice)throw new Error('No explicit approval choice: '+stderr);child.stdin.write(choice[1]+'\n');}});
      const timer=setTimeout(()=>child.kill('SIGTERM'),20000);
      const code=await new Promise<number|null>((r,reject)=>{child.once('error',reject);child.once('close',r);});clearTimeout(timer);
      expect(code,stderr).toBe(0);expect(stdout).toContain('terminal runtime verified');return {answers,stderr};
    }
    expect((await run()).answers).toBe(1);expect(existsSync(join(workspace,'terminal.txt'))).toBe(approved);
    const histories=readdirSync(join(state,'sessions'));expect(histories).toHaveLength(1);
    const history=join(state,'sessions',histories[0]);
    const before=readFileSync(history,'utf8');expect(before).toContain('pi-runtime-assembly');
    expect((await run(['--session',history])).answers).toBe(0);
    expect(readFileSync(history,'utf8').length).toBeGreaterThan(before.length);
    expect(requests.length).toBeGreaterThanOrEqual(3);
    const header=JSON.parse(readFileSync(history,'utf8').split('\n')[0]);
    const launch=join(root,'launch.json');writeFileSync(launch,JSON.stringify({version:1,binary:'/opt/homebrew/bin/pi',workspace,provider:'fixture',model:'probe',mode:'pi-ask',sessionId:header.id,sessionFile:history,sourceAgentDir:source}));
    const rpc=spawn(executable??process.execPath,[...(executable?[]:[fileURLToPath(new URL('../bin/pi-runtime.mjs',import.meta.url))]),'--profile',profile,'--mode','rpc','--launch-spec',launch],{cwd:'/private/tmp',env:{...process.env},stdio:['pipe','pipe','pipe']});
    let buffer='',messages:any,sessionDirectory='',errors='';rpc.stderr.on('data',c=>errors+=c);
    const timer=setTimeout(()=>rpc.kill('SIGTERM'),20000);
    rpc.stdout.on('data',c=>{buffer+=c;let i;while((i=buffer.indexOf('\n'))>=0){const event=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(event.type==='runtime_ready'){sessionDirectory=event.sessionDirectory;rpc.stdin.write(JSON.stringify({type:'get_messages',id:'frontend-history'})+'\n');}if(event.type==='response'&&event.id==='frontend-history'){messages=event.data;rpc.stdin.end();}if(event.type==='runtime_error')errors+=event.error;}});
    const code=await new Promise<number|null>((r,reject)=>{rpc.once('error',reject);rpc.once('close',r);});clearTimeout(timer);
    expect(code,errors).toBe(0);expect(JSON.stringify(messages)).toContain('terminal runtime verified');expect(sessionDirectory).not.toBe('');expect(existsSync(sessionDirectory)).toBe(false);

  },50000);
});
