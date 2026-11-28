/** Host-owned browser lifecycle and screenshot receipts, shared by every runtime. */
import {createServer, type Socket} from 'node:net';
import {createHash, randomUUID} from 'node:crypto';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, realpathSync, copyFileSync, lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, resolve, isAbsolute, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, type Browser, type Page} from 'playwright';
import type {DriverEvent} from './driver.js';
import {readChatGPTShare} from './chatgpt-share.js';
import {readPublicLink} from './public-link-reader.js';
export interface BrowserAccess {socketPath: string; pointerPath?: string; bridgePath: string; hookPath: string}
const rawBrowserBridgePath=fileURLToPath(new URL('../../pi-runtime/src/platform-browser-mcp.mjs',import.meta.url));
/** 仅当 current 确实指向当前槽时才换用 current 别名：上线后跨蓝绿槽路径稳定，而预发/门禁槽里 current 仍指旧槽，会继续执行本槽自己的新桥接脚本。 */
export function stableBrowserBridgePath(real:string,resolveAlias:(path:string)=>string|undefined=p=>{try{return lstatSync(p).isSymbolicLink()?realpathSync(p):undefined;}catch{return undefined;}}):string{
 const marker=sep+'slots'+sep,at=real.lastIndexOf(marker);if(at<0)return real;
 const rest=real.slice(at+marker.length),cut=rest.indexOf(sep);if(cut<=0)return real;
 const base=real.slice(0,at),slotRoot=join(base,'slots',rest.slice(0,cut)),alias=join(base,'current');
 const target=resolveAlias(alias);if(!target)return real;
 let realSlot=slotRoot;try{realSlot=realpathSync(slotRoot);}catch{/* 虚拟路径单测 */}
 return target===slotRoot||target===realSlot?join(alias,rest.slice(cut+1)):real;
}
export const browserBridgePath=stableBrowserBridgePath(rawBrowserBridgePath);
export const browserHookPath=fileURLToPath(new URL('../../pi-runtime/src/screenshot-policy-hook.mjs',import.meta.url));
export interface ScreenshotReceipt {receiptId:string;sessionId:string;turnId:string;path:string;sha256:string;url:string;width:number;height:number;theme:string;capturedAt:string}
export function verifyScreenshotReceipt(receipt:ScreenshotReceipt,sessionId:string,events:readonly {source:string;tool?:{name:string;input?:string;output?:string;status?:string}}[]):boolean {
 if(receipt.sessionId!==sessionId||!events.some(e=>e.source!=='platform'&&/platform_browser(?:__|\.)browser|^platform_browser$/.test(e.tool?.name??'')&&/completed|success/.test(e.tool?.status??'')&&/"action"\s*:\s*"screenshot"/.test(e.tool?.input??'')&&e.tool?.output?.includes(receipt.receiptId)))return false;
 try{return createHash('sha256').update(readFileSync(receipt.path)).digest('hex')===receipt.sha256;}catch{return false;}
}
export async function startPlatformBrowser(options:{sessionId:string;turnId:string;workspace:string;outputDir:string;event(e:DriverEvent):void;launch?:()=>Promise<Browser>;linkOnly?:boolean}) {
 const tag=createHash('sha256').update(options.sessionId).digest('hex').slice(0,12);
 const dir=mkdtempSync(join(tmpdir(),`pb-${tag}-`)), socketPath=join(dir,'b.sock'), pointer=join(tmpdir(),`pb-${tag}.sock`);
 // Pin the guard bytes outside the agent workspace for this turn.
 for(const name of ['screenshot-policy-hook.mjs','screenshot-policy.mjs']){copyFileSync(fileURLToPath(new URL('../../pi-runtime/src/'+name,import.meta.url)),join(dir,name));chmodSync(join(dir,name),0o400);}
 let browser:Browser|undefined,page:Page|undefined,opening:Promise<Page>|undefined,closed=false,busy=false,theme='light';
 const sockets=new Set<Socket>(),receipts:ScreenshotReceipt[]=[];
 async function closeBrowser(){page=undefined;const pending=opening;opening=undefined;await pending?.catch(()=>undefined);await browser?.close();browser=undefined;}
 async function getPage(){
  if(closed)throw new Error('Browser service closed');
  if(!page){theme='light';opening??=(async()=>{browser=await(options.launch?.()??chromium.launch({headless:true}));if(closed){await browser.close();throw new Error('Browser service closed');}const context=await browser.newContext({viewport:{width:390,height:844},colorScheme:'light',serviceWorkers:'block'});context.setDefaultTimeout(10000);return context.newPage();})();page=await opening;}
  return page;
 }
 function assertUrl(raw:string){const u=new URL(raw);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||!['127.0.0.1','localhost','[::1]','console.example.com'].includes(u.hostname))throw new Error('验收地址仅允许本机页面及 console.example.com');}
 async function execute(p:Record<string,unknown>,signal:AbortSignal){
  if(typeof p.action!=='string')throw new Error('action required');
  if(p.action==='read_chatgpt_share')return readChatGPTShare(p.url,signal);
  if(p.action==='read_link')return readPublicLink(p.url,signal);
  if(options.linkOnly)throw new Error('此工具仅用于补读公开链接');
  if(p.action==='close'){await closeBrowser();return {ok:true};}
  touch();
  const current=await getPage();
  const selector=()=>{if(typeof p.selector!=='string'||p.selector.length>2000)throw new Error('selector required');return current.locator(p.selector);};
  const value=()=>{if(typeof p.value!=='string'||p.value.length>10000)throw new Error('value required');return p.value;};
  switch(p.action){
   case 'open':assertUrl(String(p.url));await current.unroute('**/*');await current.route('**/*',route=>{if(route.request().isNavigationRequest())try{assertUrl(route.request().url());}catch{return route.abort();}return route.continue();});await current.goto(String(p.url),{waitUntil:'domcontentloaded',timeout:20000});break;
   case 'inspect':return {ok:true,url:current.url(),dom:(await current.locator('body').ariaSnapshot()).slice(0,24000)};
   case 'click':await selector().click();break;
   case 'fill':await selector().fill(value());break;
   case 'select':await selector().selectOption(value());break;
   case 'press':await selector().press(value());break;
   case 'upload':{const path=realpathSync(resolve(options.workspace,String(p.path))),rel=relative(realpathSync(options.workspace),path);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Upload must be inside workspace');await selector().setInputFiles(path);break;}
   case 'viewport':{const width=Number(p.width),height=Number(p.height);if(!Number.isInteger(width)||!Number.isInteger(height)||width<320||width>2560||height<320||height>2560)throw new Error('Invalid viewport');await current.setViewportSize({width,height});break;}
   case 'theme':if(p.theme!=='light'&&p.theme!=='dark')throw new Error('Invalid theme');theme=p.theme;await current.emulateMedia({colorScheme:p.theme});break;
   case 'screenshot':{
    assertUrl(current.url());
    const receiptId=randomUUID();mkdirSync(options.outputDir,{recursive:true,mode:0o700});
    const root=realpathSync(options.workspace),output=realpathSync(options.outputDir),rel=relative(root,output);
    if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Screenshot output escaped workspace');
    const path=join(output,receiptId+'.png');
    const bytes=await current.screenshot({fullPage:p.fullPage===true,timeout:15000,animations:'disabled'});writeFileSync(path,bytes,{flag:'wx',mode:0o400});
    const size=current.viewportSize()!;
    const receipt:ScreenshotReceipt={receiptId,sessionId:options.sessionId,turnId:options.turnId,path,sha256:createHash('sha256').update(bytes).digest('hex'),url:current.url(),...size,theme,capturedAt:new Date().toISOString()};
    options.event({key:'platform-browser:'+receiptId,kind:'tool',source:'platform',parserVersion:'platform-browser@1',availability:'recorded',tool:{name:'platform_browser.receipt',status:'completed',output:JSON.stringify(receipt)}});receipts.push(receipt);return {ok:true,...receipt};
   }
   default:throw new Error('Unsupported browser action');
  }
  return {ok:true,url:current.url()};
 }
 const recordOutput=(line:string)=>{try{writeFileSync(`${socketPath}.log`,line+'\n',{flag:'a',mode:0o600});}catch{/* best-effort log for ACP runtimes */}};
 const server=createServer(socket=>{const cancellation=new AbortController();sockets.add(socket);socket.once('close',()=>{sockets.delete(socket);cancellation.abort();});socket.setTimeout(65000,()=>socket.destroy());let buffer='';socket.on('data',chunk=>{buffer+=chunk;if(buffer.length>128000){socket.destroy();return;}if(!buffer.includes('\n'))return;socket.removeAllListeners('data');if(busy||closed){const line=JSON.stringify({ok:false,error:'Browser busy or closed'});recordOutput(line);socket.end(line+'\n');return;}busy=true;let timer:NodeJS.Timeout;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void closeBrowser();reject(new Error('Browser action exceeded 60s'));},60000);});
  void Promise.race([Promise.resolve().then(()=>execute(JSON.parse(buffer.split('\n')[0]),cancellation.signal)),timeout]).then(result=>{const line=JSON.stringify(result);recordOutput(line);socket.end(line+'\n');},error=>{const line=JSON.stringify({ok:false,error:String(error.message)});recordOutput(line);socket.end(line+'\n');}).finally(()=>{clearTimeout(timer);busy=false;});
 });});
 try{await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(socketPath,yes);});}catch(error){rmSync(dir,{recursive:true,force:true});throw error;}chmodSync(socketPath,0o600);
 // 在本轮 socket 监听就绪后再原子切换每会话指针，避免并发 MCP 桥接读到半截内容或连上未就绪的 socket。
 const pointerTmp=`${pointer}.${randomUUID().slice(0,8)}.tmp`;
 try{writeFileSync(pointerTmp,socketPath,{mode:0o600,flag:'wx'});renameSync(pointerTmp,pointer);}catch{try{rmSync(pointerTmp,{force:true});}catch{}}
 let idle:NodeJS.Timeout|undefined;
 function touch(){clearTimeout(idle);idle=setTimeout(()=>{void closeBrowser();},180000);idle.unref();}
 async function dispose(){if(closed)return;closed=true;clearTimeout(idle);for(const s of sockets)s.destroy();server.close();await closeBrowser();try{if(readFileSync(pointer,'utf8').trim()===socketPath)rmSync(pointer,{force:true});}catch{}rmSync(dir,{recursive:true,force:true});}
 return {access:{socketPath,pointerPath:pointer,bridgePath:stableBrowserBridgePath(rawBrowserBridgePath),hookPath:join(dir,'screenshot-policy-hook.mjs')} satisfies BrowserAccess,receipts,dispose};
}

/** Only host receipts plus a successful native screenshot call authorize a reported image. */
export function screenshotReportProblems(text:string,sessionId:string,workspace:string,events:readonly {source:string;tool?:{name:string;input?:string;output?:string;status?:string}}[]):string[]{
 if(!/截图|screenshot|改前|改后/i.test(text))return [];
 const receipts:ScreenshotReceipt[]=[];
 for(const e of events)if(e.source==='platform'&&e.tool?.name==='platform_browser.receipt')try{receipts.push(JSON.parse(e.tool.output??''));}catch{/* invalid host receipt is never accepted */}
 const refs=[...text.matchAll(/!?\[[^\]]*\]\(<?([^)>]+\.(?:png|jpe?g|webp))>?\)/gi)].map(x=>resolve(workspace,x[1]));
 return [...new Set(refs)].filter(path=>!receipts.some(r=>r.path===path&&verifyScreenshotReceipt(r,sessionId,events))).map(path=>`截图缺少平台工具来源或字节不匹配：${path}`);
}
