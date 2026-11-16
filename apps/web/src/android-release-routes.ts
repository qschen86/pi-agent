import type { Hono, Context } from 'hono';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
interface Release { applicationId:string;versionCode:number;versionName:string;sha256:string;minSdk:number;notes?:string[] }
/** 每一版的一句话更新点：打包时写入 release.json / notes.json，页面据 versionCode 对上。 */
export const NOTE_MAX_CHARS=60, NOTES_PER_VERSION=5, NOTES_VERSIONS_MAX=400, NOTES_FILE_MAX_BYTES=32768;
export function parseReleaseNotes(value:unknown):string[]|undefined {
 if(value===undefined)return undefined;
 if(!Array.isArray(value)||value.length<1||value.length>NOTES_PER_VERSION)throw Error('notes');
 return value.map(item=>{
  if(typeof item!=='string')throw Error('notes');
  const text=item.trim();
  // 一句话：不可为空、不可换行或夹带控制字符（页面按纯文本渲染，不另做转义）。
  if(!text||text.length>NOTE_MAX_CHARS||/[\u0000-\u001f\u007f]/.test(text))throw Error('notes');
  return text;
 });
}
/** First X-Forwarded-Host value if it is a plain host[:port]; anything else (userinfo, path, spaces) is ignored. */
export function forwardedHost(value:string|undefined):string|undefined {
 const first=value?.split(',')[0]?.trim().toLowerCase();
 return first&&/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/.test(first)?first:undefined;
}
export function mountAndroidReleaseRoutes(app:Hono,options:{dir?:string;canRead:(c:Context)=>boolean;isPublic?:(c:Context)=>boolean}):void {
 const metadata=async():Promise<Release|undefined>=>{
  if(!options.dir)return;
  const file=join(options.dir,'release.json');if((await stat(file)).size>16384)throw Error('manifest');
  const j=JSON.parse(await readFile(file,'utf8')) as Release;
  if(j.applicationId!=='fund.harness.piagent'||!Number.isSafeInteger(j.versionCode)||j.versionCode<1||typeof j.versionName!=='string'||j.versionName.length<1||j.versionName.length>80||!/^[a-f0-9]{64}$/.test(j.sha256)||!Number.isInteger(j.minSdk)||j.minSdk<26||j.minSdk>100)throw Error('manifest');
  const notes=parseReleaseNotes(j.notes);
  return {applicationId:j.applicationId,versionCode:j.versionCode,versionName:j.versionName,sha256:j.sha256,minSdk:j.minSdk,...(notes?{notes}:{})};
 };
 /** notes.json：versionCode → 一句话更新点，用于「版本历史」里每一条历史版本；坏文件整份不认，不半信半疑地拼。 */
 const notesIndex=async():Promise<Record<string,string[]>>=>{
  const out:Record<string,string[]>={};
  if(!options.dir)return out;
  const file=join(options.dir,'notes.json');
  // 还没有 notes.json（本功能上线前的发布目录）只是没有历史更新点，不算坏文件。
  if(!existsSync(file))return out;
  if((await stat(file)).size>NOTES_FILE_MAX_BYTES)throw Error('notes');
  const parsed=JSON.parse(await readFile(file,'utf8')) as unknown;
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('notes');
  for(const [code,value] of Object.entries(parsed as Record<string,unknown>)){
   if(Object.keys(out).length>=NOTES_VERSIONS_MAX)break;
   if(!/^[1-9]\d{0,9}$/.test(code))continue;
   const notes=parseReleaseNotes(value);if(notes)out[code]=notes;
  }
  return out;
 };
 const guard=(c:Context)=>{c.header('Cache-Control','private, no-store');return options.canRead(c)?undefined:c.json({error:'请先登录并启用会话读取权限'},401);};
 app.get('/api/android/release',async c=>{
  const rejected=guard(c);if(rejected)return rejected;
  try{
   const release=await metadata();
   // The TLS-terminating proxy in front of the service speaks plain HTTP to it, so the request URL says http://.
   // The app only accepts https on the very origin it is connected to: public requests are https on the Host they came in on.
   const origin=new URL(c.req.url);if(options.isPublic?.(c))origin.protocol='https:';
   // Some public entrances (the CN backup Caddy) rewrite Host to an allowed one before forwarding, so the Host we see is not
   // the address the app is connected to. The app only accepts a download URL on its own origin, so prefer the original host
   // the proxy reports. Safe: only the caller's own response changes, and the app still pins origin, SHA-256 and signing cert.
   const forwarded=options.isPublic?.(c)?forwardedHost(c.req.header('x-forwarded-host')):undefined;
   if(forwarded){const [name,port]=forwarded.split(':');origin.hostname=name!;origin.port=port??'';}
   return c.json(release?{...release,apkUrl:new URL(`/api/android/releases/${release.versionCode}.apk`,origin).href}:{available:false});
  }
  catch{return c.json({error:'安装包尚未通过发布校验'},503);}
 });
 // 版本页用：最新版本（发布信息里的更新点）+ 每个历史版本的更新点。没有发布目录 / 没有 notes.json 时给空集合，不编造内容。
 app.get('/api/android/release-notes',async c=>{
  const rejected=guard(c);if(rejected)return rejected;
  try{
   const release=await metadata();
   const versions=await notesIndex();
   if(release?.notes)versions[String(release.versionCode)]=release.notes;
   return c.json({latest:release?{versionCode:release.versionCode,versionName:release.versionName,notes:release.notes??[]}:null,versions});
  }catch{return c.json({error:'更新内容暂时读不到'},503);}
 });
 // The digest of a published file is cached by (size, mtime): it is checked once, not on every request and every resumed range.
 const verified=new Map<string,{size:number;mtimeMs:number;sha256:string}>();
 const checkedFile=async(path:string,expected:string):Promise<number>=>{
  const info=await stat(path);if(info.size>50*1024*1024)throw Error('size');
  const known=verified.get(path);
  if(known&&known.size===info.size&&known.mtimeMs===info.mtimeMs&&known.sha256===expected)return info.size;
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path))hash.update(chunk as Buffer);
  if(hash.digest('hex')!==expected)throw Error('digest');
  verified.set(path,{size:info.size,mtimeMs:info.mtimeMs,sha256:expected});
  return info.size;
 };
 // RFC 9110 single byte range. null = no (usable) Range header: serve everything; 'unsatisfiable' = 416.
 const parseRange=(header:string|undefined,size:number):{start:number;end:number}|'unsatisfiable'|null=>{
  if(!header)return null;
  const m=/^bytes=(\d*)-(\d*)$/.exec(header.trim());if(!m||(m[1]===''&&m[2]===''))return null;
  let start:number,end:number;
  if(m[1]===''){const n=Number(m[2]);if(n===0)return 'unsatisfiable';start=Math.max(0,size-n);end=size-1;}
  else{start=Number(m[1]);end=m[2]===''?size-1:Math.min(Number(m[2]),size-1);}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)return 'unsatisfiable';
  return {start,end};
 };
 app.get('/api/android/releases/:apk',async c=>{
  const rejected=guard(c);if(rejected)return rejected;
  try{
   const release=await metadata();if(!release||c.req.param('apk')!==`${release.versionCode}.apk`)return c.json({error:'版本不存在'},404);
   const path=join(options.dir!,`${release.versionCode}.apk`);
   const size=await checkedFile(path,release.sha256);
   // The strong validator is the content digest itself: a resumed download can prove the bytes on disk belong to this very file.
   const etag=`"${release.sha256}"`;
   c.header('Content-Type','application/vnd.android.package-archive');c.header('Content-Disposition',`attachment; filename="pi-agent-${release.versionCode}.apk"`);
   c.header('Accept-Ranges','bytes');c.header('ETag',etag);
   const ifRange=c.req.header('if-range');
   const range=ifRange&&ifRange!==etag?null:parseRange(c.req.header('range'),size);
   if(range==='unsatisfiable'){c.header('Content-Range',`bytes */${size}`);return c.body(null,416);}
   const {start,end}=range??{start:0,end:size-1};
   c.header('Content-Length',String(end-start+1));
   if(range)c.header('Content-Range',`bytes ${start}-${end}/${size}`);
   const body=Readable.toWeb(createReadStream(path,{start,end})) as ReadableStream<Uint8Array>;
   return c.body(body,range?206:200);
  }catch{return c.json({error:'安装包尚未通过发布校验'},503);}
 });
}
