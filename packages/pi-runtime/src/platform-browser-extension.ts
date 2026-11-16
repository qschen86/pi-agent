/** Copied read-only alongside the Pi gate. */
import {createConnection} from 'node:net';
export default function install(pi:{registerTool(tool:unknown):void}){
 const path=process.env.PI_PLATFORM_BROWSER_SOCKET;if(!path)return;
 const kind=Symbol.for('TypeBox.Kind');
 pi.registerTool({name:'platform_browser',label:'平台浏览器',description:'真实浏览器打开/检查/点击/输入/上传、切换尺寸与主题、截图。截图返回 receiptId 与路径，必须原样引用。',parameters:{[kind]:'Object',type:'object',required:['action'],properties:Object.fromEntries(Object.entries({action:'string',url:'string',selector:'string',value:'string',path:'string',width:'integer',height:'integer',theme:'string',fullPage:'boolean'}).map(([k,t])=>[k,{[kind]:t==='integer'?'Integer':t==='boolean'?'Boolean':'String',type:t}]))},execute:async(_id:string,params:unknown,signal?:AbortSignal)=>{
  const result=await new Promise<string>((yes,no)=>{let buffer='';const s=createConnection(path);const finish=(error?:Error,text?:string)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);s.destroy();if(error)no(error);else yes(text!);};const abort=()=>finish(new Error('Browser action cancelled'));const timer=setTimeout(()=>finish(new Error('Browser tool timed out')),65000);if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});s.on('connect',()=>s.write(JSON.stringify(params)+'\n'));s.on('data',c=>{buffer+=c;if(buffer.length>4*1024*1024)finish(new Error('Response too large'));else if(buffer.includes('\n'))finish(undefined,buffer.split('\n')[0]);});s.on('error',e=>finish(e));s.on('end',()=>finish(new Error('Browser service disconnected')));});
  const out=JSON.parse(result);if(!out.ok)throw new Error(out.error);return {content:[{type:'text',text:result}]};
 }});
}
