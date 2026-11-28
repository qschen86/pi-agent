import {describe,it,expect} from 'vitest';
import {createConnection} from 'node:net';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {screenshotViolation} from '../../pi-runtime/src/screenshot-policy.mjs';
import {startPlatformBrowser,stableBrowserBridgePath,verifyScreenshotReceipt} from '../src/platform-browser.js';
import type {Browser} from 'playwright';
import type {DriverEvent} from '../src/driver.js';
describe('platform screenshot policy',()=>{
 it.each(['bash','Write','apply_patch','functions.exec','mcp__node_repl__js'])('blocks inline capture through %s',name=>expect(screenshotViolation(name,{command:'await page.screenshot({path:"x.png"})'})).toContain('SCREENSHOT_TOOL_REQUIRED'));
 it('inspects renamed executable content and keeps test runners',()=>{const dir=mkdtempSync(join(tmpdir(),'policy-'));try{writeFileSync(join(dir,'ordinary.mjs'),'await page.screenshot({path:"x.png"})');expect(screenshotViolation('bash',{command:'node ordinary.mjs'},dir)).toBeTruthy();expect(screenshotViolation('bash',{command:'npx vitest run apps/web/test/app.test.ts'},dir)).toBeUndefined();expect(screenshotViolation('bash',{command:'npx vitest run; node ordinary.mjs'},dir)).toBeTruthy();expect(screenshotViolation('Write',{path:'scripts/a.mjs',content:'page.screenshot()'})).toBeTruthy();expect(screenshotViolation('Write',{path:'apps/web/test/a.test.ts',content:'page.screenshot()'})).toBeUndefined();}finally{rmSync(dir,{recursive:true,force:true});}});
});
it('records screenshots, verifies native tool association and detects altered bytes; closes all resources',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'browser-')),events:DriverEvent[]=[];let closed=0;
 const page={screenshot:async()=>Buffer.from('image'),viewportSize:()=>({width:390,height:844}),url:()=> 'http://localhost:8780/',};
 const browser={newContext:async()=>({setDefaultTimeout(){},newPage:async()=>page}),close:async()=>{closed++;}} as unknown as Browser;
 const service=await startPlatformBrowser({sessionId:'s1',turnId:'t1',workspace:dir,outputDir:dir,event:e=>events.push(e),launch:async()=>browser});
 try{
  const result=await new Promise<string>((yes,no)=>{const socket=createConnection(service.access.socketPath);let data='';socket.on('connect',()=>socket.write(JSON.stringify({action:'screenshot'})+'\n'));socket.on('data',c=>data+=c);socket.on('end',()=>yes(data));socket.on('error',no);});
  const receipt=JSON.parse(result);expect(receipt.ok).toBe(true);expect(receipt.sha256).toBe(createHash('sha256').update('image').digest('hex'));expect(events[0].source).toBe('platform');
  expect(verifyScreenshotReceipt(receipt,'s1',events)).toBe(false);
  const native={source:'stream',tool:{name:'platform_browser.browser',status:'completed',input:'{"action":"screenshot"}',output:result}};
  expect(verifyScreenshotReceipt(receipt,'s1',[...events,native])).toBe(true);
  expect(verifyScreenshotReceipt(receipt,'s2',[native])).toBe(false);
  // Simulate replacement rather than writing through read-only file permissions.
  rmSync(receipt.path);writeFileSync(receipt.path,'tampered');expect(verifyScreenshotReceipt(receipt,'s1',[native])).toBe(false);
 }finally{await service.dispose();expect(closed).toBe(1);rmSync(dir,{recursive:true,force:true});}
});
it('renders a real page through the platform tool, switches theme and viewport, then releases browser and socket',async()=>{
 const {createServer}=await import('node:http');
 const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><html><body><label>Name<input id="name"></label><button id="go">Continue</button></body></html>');});
 await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));
 const dir=mkdtempSync(join(tmpdir(),'browser-real-')),events:DriverEvent[]=[];
 const tool=await startPlatformBrowser({sessionId:'real',turnId:'t',workspace:dir,outputDir:dir,event:e=>events.push(e)});
 const call=(args:unknown)=>new Promise<any>((yes,no)=>{const s=createConnection(tool.access.socketPath);let data='';s.on('connect',()=>s.write(JSON.stringify(args)+'\n'));s.on('data',c=>data+=c);s.on('end',()=>yes(JSON.parse(data)));s.on('error',no);});
 try{
  const address=server.address() as {port:number};expect((await call({action:'open',url:`http://127.0.0.1:${address.port}`})).ok).toBe(true);
  expect((await call({action:'inspect'})).dom).toContain('Continue');
  expect((await call({action:'fill',selector:'#name',value:'hello'})).ok).toBe(true);
  expect((await call({action:'viewport',width:320,height:568})).ok).toBe(true);
  expect((await call({action:'theme',theme:'dark'})).ok).toBe(true);
  const image=await call({action:'screenshot'});expect(image.ok).toBe(true);expect(image.width).toBe(320);expect(image.theme).toBe('dark');
  const bytes=(await import('node:fs')).readFileSync(image.path);expect(bytes.subarray(1,4).toString()).toBe('PNG');
  expect((await call({action:'open',url:'file:///etc/passwd'})).ok).toBe(false);
  expect((await call({action:'upload',selector:'#name',path:'/etc/hosts'})).ok).toBe(false);
 }finally{await tool.dispose();await new Promise<void>(yes=>server.close(()=>yes()));rmSync(dir,{recursive:true,force:true});}
});
it('rejects report images without host receipts and rejects inspect output masquerading as a screenshot',async()=>{
 const {screenshotReportProblems}=await import('../src/platform-browser.js');
 expect(screenshotReportProblems('截图 ![a](shots/a.png)','s','/work',[])).toEqual(['截图缺少平台工具来源或字节不匹配：/work/shots/a.png']);
 expect(screenshotReportProblems('普通照片 ![a](photo.png)','s','/work',[])).toEqual([]);
 const dir=mkdtempSync(join(tmpdir(),'receipt-'));try{const path=join(dir,'a.png');writeFileSync(path,'x');const receipt={receiptId:'r',sessionId:'s',turnId:'t',path,sha256:createHash('sha256').update('x').digest('hex'),url:'http://localhost',width:390,height:844,theme:'light',capturedAt:'now'};
 expect(verifyScreenshotReceipt(receipt,'s',[{source:'stream',tool:{name:'platform_browser.browser',input:'{"action":"inspect"}',status:'completed',output:JSON.stringify(receipt)}}])).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('keeps a stable per-session pointerPath and slot alias so a long-lived MCP bridge routes across turns without config changes',async()=>{
 // 仅当 current 指向当前槽时才用 current 别名；预发/门禁槽（current 仍指另一槽）保留本槽路径以测本槽代码。
 expect(stableBrowserBridgePath('/u/.pi-agent-gui/slots/blue/packages/pi-runtime/src/platform-browser-mcp.mjs',p=>p==='/u/.pi-agent-gui/current'?'/u/.pi-agent-gui/slots/blue':undefined)).toBe('/u/.pi-agent-gui/current/packages/pi-runtime/src/platform-browser-mcp.mjs');
 expect(stableBrowserBridgePath('/u/.pi-agent-gui/slots/green/packages/pi-runtime/src/platform-browser-mcp.mjs',p=>p==='/u/.pi-agent-gui/current'?'/u/.pi-agent-gui/slots/green':undefined)).toBe('/u/.pi-agent-gui/current/packages/pi-runtime/src/platform-browser-mcp.mjs');
 expect(stableBrowserBridgePath('/u/.pi-agent-gui/slots/blue/packages/pi-runtime/src/platform-browser-mcp.mjs',p=>p==='/u/.pi-agent-gui/current'?'/u/.pi-agent-gui/slots/green':undefined)).toBe('/u/.pi-agent-gui/slots/blue/packages/pi-runtime/src/platform-browser-mcp.mjs');
 expect(stableBrowserBridgePath('/u/repo/packages/pi-runtime/src/platform-browser-mcp.mjs',()=>'/u/current')).toBe('/u/repo/packages/pi-runtime/src/platform-browser-mcp.mjs');
 const {spawn}=await import('node:child_process');
 const {createInterface}=await import('node:readline');
 const dir=mkdtempSync(join(tmpdir(),'browser-stable-')),events1:DriverEvent[]=[],events2:DriverEvent[]=[];
 const makeBrowser=(bytes:string)=>({newContext:async()=>({setDefaultTimeout(){},newPage:async()=>({screenshot:async()=>Buffer.from(bytes),viewportSize:()=>({width:390,height:844}),url:()=>'http://127.0.0.1:8780/'})}),close:async()=>{}}) as unknown as Browser;
 const s1=await startPlatformBrowser({sessionId:'stable-sess',turnId:'t1',workspace:dir,outputDir:dir,event:e=>events1.push(e),launch:async()=>makeBrowser('png-1')});
 const child=spawn(process.execPath,[s1.access.bridgePath,s1.access.pointerPath!],{stdio:['pipe','pipe','pipe']});
 const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
 const call=async(id:number)=>{child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'browser',arguments:{action:'screenshot'}}})+'\n');const next=await lines.next();expect(next.done).toBe(false);return JSON.parse(JSON.parse(String(next.value)).result.content[0].text);};
 try{
  const r1=await call(1);
  expect(r1.ok).toBe(true);expect(s1.receipts).toHaveLength(1);
  // Turn 2 starts before Turn 1 disposes (Antigravity continuation overlap); pointerPath stays identical.
  const s2=await startPlatformBrowser({sessionId:'stable-sess',turnId:'t2',workspace:dir,outputDir:dir,event:e=>events2.push(e),launch:async()=>makeBrowser('png-2')});
  try{
   expect(s2.access.pointerPath).toBe(s1.access.pointerPath);
   expect(s2.access.socketPath).not.toBe(s1.access.socketPath);
   await s1.dispose();
   const r2=await call(2);
   expect(r2.ok).toBe(true);expect(r2.turnId).toBe('t2');expect(s2.receipts).toHaveLength(1);expect(s2.receipts[0]!.receiptId).toBe(r2.receiptId);
  }finally{await s2.dispose();}
 }finally{child.kill();await s1.dispose();rmSync(dir,{recursive:true,force:true});}
});
