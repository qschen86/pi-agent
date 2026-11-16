#!/usr/bin/env node
/** The context path is public; its credential is never accepted in CLI arguments or printed. */
import {readFileSync,lstatSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export async function recordFromContext(file,input,{fetchImpl=fetch}={}){
 const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0)throw new Error('记录上下文权限无效');
 let c;try{c=JSON.parse(readFileSync(file,'utf8'));}catch{throw new Error('记录上下文损坏');}let u;try{u=new URL(c.origin);}catch{throw new Error('记录上下文无效');}
 if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||!/^rt-[\w-]+$/.test(c.sessionId)||typeof c.capability!=='string')throw new Error('记录上下文无效');
 if(!input||typeof input!=='object'||typeof input.idempotencyKey!=='string'||!input.idempotencyKey)throw new Error('需要 JSON 输入和稳定幂等键');
 const res=await fetchImpl(`${u.origin}/api/runtime-sessions/${encodeURIComponent(c.sessionId)}/records`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json','x-pi-record-capability':c.capability},body:JSON.stringify(input)});
 const value=await res.json();if(!res.ok)throw new Error(`记录失败（${res.status}）：${String(value.error??'请重试').slice(0,200)}`);return value;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{if(process.argv[2]!=='--context'||!process.argv[3]||process.argv.length!==4)throw new Error('用法：runtime-record.mjs --context <上下文文件>，从 stdin 读取 JSON');let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>200000)throw new Error('输入过大');}const result=await recordFromContext(process.argv[3],JSON.parse(text));process.stdout.write(JSON.stringify({id:result.id,relationCount:result.relationCount})+'\n');}catch(e){process.stderr.write((e.message??'记录失败')+'\n');process.exitCode=1;}}
