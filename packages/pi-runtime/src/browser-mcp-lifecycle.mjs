/** Use the community MCP server API, with a runtime-owned browser context lifecycle. */
import {createRequire} from 'node:module';
import {dirname} from 'node:path';
import {createServer} from 'node:net';
import {chmodSync,existsSync,renameSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2),require=createRequire(args[0]);
const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const directory=option('--runtime-state-dir'),executablePath=option('--executable-path'),controlPath=option('--runtime-control-socket');
if(!directory||!executablePath||!controlPath)throw new Error('Persistent browser transport requires explicit managed paths');
const {createConnection}=require(dirname(args[0]));
const {chromium}=require('playwright');
let browser,context,opening,closing,flushing,buffer=Buffer.alloc(0);
const stateFile=join(directory,'storage-state.json');
async function getContext(){
  if(closing||flushing)throw new Error('Browser transport is closing');
  if(context)return context;
  opening??=(async()=>{browser=await chromium.launch({executablePath,headless:true,chromiumSandbox:false});return browser.newContext({...(existsSync(stateFile)?{storageState:stateFile}:{})});})();
  context=await opening;
  return context;
}
const server=await createConnection({browser:{browserName:'chromium'}},getContext);
const transport={
  async start(){},
  async send(message){await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(message)+'\n',error=>error?reject(error):resolve()));},
  async close(){process.stdin.pause();transport.onclose?.();},
};
await server.connect(transport);
function flushBrowser(){return flushing??=(async()=>{
  const active=context??await opening?.catch(()=>undefined);
  try{
    if(active){const temporary=stateFile+'.tmp';await active.storageState({path:temporary,indexedDB:true});chmodSync(temporary,0o600);renameSync(temporary,stateFile);}
  }finally{await active?.close();await browser?.close();}
})();}
const control=createServer(socket=>{
  socket.setTimeout(6000,()=>socket.destroy());let command='';
  socket.on('data',chunk=>{command+=chunk.toString();if(command==='close\n')void flushBrowser().then(()=>socket.end('closed\n'),()=>socket.end('failed\n'));else if(command.length>6)socket.destroy();});
});
await new Promise((resolve,reject)=>{control.once('error',reject);control.listen(controlPath,resolve);});
async function close(){
  if(closing)return closing;
  process.stdin.pause();
  closing=(async()=>{
    try{await flushBrowser();}
    finally{control.close();await server.close();}
  })();
  const timeout=setTimeout(()=>process.exit(1),5000);timeout.unref();
  try{await closing;}finally{clearTimeout(timeout);}
}
process.stdin.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  if(buffer.length>4*1024*1024){transport.onerror?.(new Error('MCP input exceeds runtime limit'));void close();return;}
  let end;while((end=buffer.indexOf(10))>=0){const line=buffer.subarray(0,end).toString('utf8');buffer=buffer.subarray(end+1);if(!line.trim())continue;try{transport.onmessage?.(JSON.parse(line));}catch(error){transport.onerror?.(error);void close();return;}}
});
process.stdin.once('end',()=>void close());
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
