import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {afterEach,expect,it}from'vitest';import{mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{preparePiChatBoundary}from'../src/pi-boundary.js';
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
it('scoped record client and credential file are readable, not writable, in the Pi execution boundary',async()=>{
 const d=realpathSync(mkdtempSync(join(tmpdir(),'record-boundary-')));dirs.push(d);const workspace=join(d,'work'),source=join(d,'source');mkdirSync(workspace);mkdirSync(source);writeFileSync(join(source,'auth.json'),'{}');const context=join(d,'context.json'),client=join(d,'client.mjs');writeFileSync(context,'{}',{mode:0o600});writeFileSync(client,'');
 const boundary=await preparePiChatBoundary({workspace,sourceAgentDir:source,runtimeRoot:join(d,'runtime'),guardDir:join(d,'guard'),provider:'deepseek',mode:'pi-ask',recordReadRoots:[context,client]});
 try{
 const script = "const fs=require('node:fs');const c=process.argv[1],client=process.argv[2];const out={context:fs.readFileSync(c,'utf8'),client:fs.readFileSync(client,'utf8'),writeDenied:false,clientWriteDenied:false};try{fs.appendFileSync(c,'tamper')}catch(e){out.writeDenied=['EPERM','EACCES'].includes(e.code)}try{fs.appendFileSync(client,'tamper')}catch(e){out.clientWriteDenied=['EPERM','EACCES'].includes(e.code)}console.log(JSON.stringify(out));";
 const wrapped=await boundary.wrap(process.execPath,['-e',script,context,client]);
 const result=await promisify(execFile)(wrapped.command,wrapped.args,{cwd:workspace,env:{...boundary.env,...wrapped.env}});
 expect(JSON.parse(result.stdout)).toEqual({context:'{}',client:'',writeDenied:true,clientWriteDenied:true});
 expect(boundary.commandReadRoots).toContain(context);expect(boundary.commandReadRoots).toContain(client);expect(boundary.commandWriteRoots).not.toContain(context);expect(boundary.commandWriteRoots).not.toContain(client);}finally{await boundary.dispose();}
});
