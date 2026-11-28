/** Platform-owned stdio bridge; no browser or arbitrary code runs in the agent process. */
import {existsSync, readFileSync, statSync} from 'node:fs';
import {createConnection} from 'node:net';
import {dirname, join} from 'node:path';
import {createInterface} from 'node:readline';
const initialSocketPath=process.argv[2];
const linkOnly=process.argv.includes('--link-only')||process.argv.includes('--share-only');
const linkDescription='仅在 runtime 自有工具未能读取公开链接正文时补读，action 传 read_link，url 传原链接。';
const linkParameters={type:'object',required:['action','url'],additionalProperties:false,properties:{action:{type:'string',enum:['read_link','read_chatgpt_share']},url:{type:'string'}}};
const parameters={type:'object',required:['action'],additionalProperties:false,properties:{action:{type:'string',enum:['open','inspect','click','fill','select','press','upload','viewport','theme','screenshot','close','read_link','read_chatgpt_share']},url:{type:'string'},selector:{type:'string'},value:{type:'string'},path:{type:'string'},width:{type:'integer',minimum:320,maximum:2560},height:{type:'integer',minimum:320,maximum:2560},theme:{type:'string',enum:['light','dark']},fullPage:{type:'boolean'}}};
function resolveSocketPath(){
 try{
  const st=statSync(initialSocketPath);
  if(st.isSocket())return initialSocketPath;
  if(st.isFile()){const target=readFileSync(initialSocketPath,'utf8').trim();if(target&&existsSync(target))return target;}
 }catch{}
 const m=/pb-([0-9a-f]{12})-[^/]+$/.exec(dirname(initialSocketPath));
 if(m){try{const next=readFileSync(join(dirname(dirname(initialSocketPath)),`pb-${m[1]}.sock`),'utf8').trim();if(next&&existsSync(next))return next;}catch{}}
 return initialSocketPath;
}
function call(params){return new Promise((resolve,reject)=>{const s=createConnection(resolveSocketPath());let b='';const timer=setTimeout(()=>{s.destroy();reject(new Error('Platform browser timed out'));},65000);const done=()=>clearTimeout(timer);s.on('connect',()=>s.write(JSON.stringify(params)+'\n'));s.on('data',c=>{b+=c;if(b.length>4*1024*1024){s.destroy(new Error('Response too large'));return;}if(b.includes('\n')){done();s.destroy();try{resolve(JSON.parse(b.split('\n')[0]));}catch(e){reject(e);}}});s.on('error',e=>{done();reject(e);});s.on('end',()=>{done();reject(new Error('Platform browser disconnected'));});});}
const send=x=>process.stdout.write(JSON.stringify(x)+'\n');
for await(const line of createInterface({input:process.stdin})) {let r;try{r=JSON.parse(line);if(r.id===undefined)continue;let result;
 if(r.method==='initialize')result={protocolVersion:r.params?.protocolVersion??'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'platform_browser',version:'1.0.0'}};
 else if(r.method==='ping')result={};
 else if(r.method==='tools/list')result={tools:[{name:'browser',description:linkOnly?linkDescription:'平台浏览器：打开页面、检查 DOM、点击/输入/上传、切换尺寸和主题、真实截图。截图返回可校验 receiptId。截图需使用本工具。'+linkDescription,inputSchema:linkOnly?linkParameters:parameters}]};
 else if(r.method==='tools/call'&&r.params?.name==='browser'){const out=await call(r.params.arguments);result={content:[{type:'text',text:JSON.stringify(out)}],isError:!out.ok};}
 else {send({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'Unsupported method'}});continue;}
 send({jsonrpc:'2.0',id:r.id,result});
 }catch(e){if(r?.id!==undefined)send({jsonrpc:'2.0',id:r.id,error:{code:-32000,message:e.message}});}}
