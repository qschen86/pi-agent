/** Restricted transport for the pinned official Playwright Test MCP server. */
import {spawn} from 'node:child_process';
import {join} from 'node:path';
const [packageRoot,workspace]=process.argv.slice(2);
if(!packageRoot||!workspace)throw new Error('Runtime test package and workspace required');
const allowed=new Set(['test_list','test_run']);
const child=spawn(process.execPath,[join(packageRoot,'cli.js'),'run-test-mcp-server','--headless','--config',workspace],{cwd:workspace,env:process.env,stdio:['pipe','pipe','inherit']});
let closing=false;
const close=()=>{if(closing)return;closing=true;child.stdin.end();const timer=setTimeout(()=>child.kill('SIGTERM'),1000);timer.unref();};
function lines(stream,onMessage){let buffer='';stream.setEncoding('utf8');stream.on('data',chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>4*1024*1024){close();return;}let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;try{onMessage(JSON.parse(line));}catch{close();}}});}
const send=(stream,message)=>stream.write(JSON.stringify(message)+'\n');
lines(process.stdin,message=>{
  if(message.method==='tools/call'&&!allowed.has(message.params?.name)){send(process.stdout,{jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Tool not exposed by Pi runtime'}});return;}
  if(message.method==='initialize')message.params={...message.params,clientInfo:{...message.params?.clientInfo,cwd:workspace}};
  send(child.stdin,message);
});
lines(child.stdout,message=>{
  if(Array.isArray(message.result?.tools))message.result.tools=message.result.tools.filter(tool=>allowed.has(tool.name));
  send(process.stdout,message);
});
process.stdin.once('end',close);process.once('SIGTERM',close);process.once('SIGINT',close);
child.once('error',()=>{process.exitCode=1;process.stdin.destroy();});
child.once('exit',code=>{process.exitCode=code??1;process.stdin.destroy();});
