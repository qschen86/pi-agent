import {describe,it,expect} from 'vitest';
import {createConnection} from 'node:net';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {screenshotViolation} from '../../pi-runtime/src/screenshot-policy.mjs';
import {startPlatformBrowser,verifyScreenshotReceipt} from '../src/platform-browser.js';
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
