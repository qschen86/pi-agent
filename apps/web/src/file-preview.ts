/** V3.5 bounded, passive previews. Authorization is supplied by the source route. */
import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Context } from 'hono';
import { RuntimeError } from '@pi-agent/runtime-sessions';
import { compressImage, compressedImageHeaders, imageSizeParam } from './image-compress.js';
import { makeVideoPreview, videoPreviewParam } from './video-preview.js';
export const PREVIEW_TEXT_MAX = 1024 * 1024;
export const PREVIEW_FILE_MAX = 25 * 1024 * 1024;
export interface FileScope { workspace:string; roots:string[]; referencedFiles?:string[] }
const under = (file:string,root:string) => file === root || file.startsWith(root.endsWith(sep)?root:root+sep);
export class FilePreviewError extends Error { constructor(message:string,public status:400|403|404|409|413=403,public code='RT_FORBIDDEN'){super(message);} }
const fail = (message:string,status:400|403|404|409|413=403,code='RT_FORBIDDEN'):never => {throw new FilePreviewError(message,status,code);};
function inputPath(input:string):string {
 if(!input || input.length>4096 || /[\0\r\n]/.test(input))return fail('文件路径无效',400,'RT_INPUT');
 if(input.startsWith('file://')){try{input=fileURLToPath(input);}catch{return fail('文件地址无效',400,'RT_INPUT');}}
 if(input.startsWith('~/'))input=resolve(homedir(),input.slice(2));
 if(/^[a-z][a-z0-9+.-]*:/i.test(input))return fail('只支持本地文件路径',400,'RT_INPUT');
 return input;
}
/** Extract the same explicit links/quoted paths users can activate as file chips. */
export function temporaryFileReferences(events:ReadonlyArray<{text?:string;tool?:{input?:string;output?:string};image?:{path?:string}}> ):string[]{
 const found=new Set<string>();
 const re=/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)|["'`]((?:file:\/\/\/|\/)[^"'`\r\n]+)["'`]|((?:file:\/\/\/|\/)[^\s<>"'`|()\[\]，。；！？;,]*?\.[a-zA-Z0-9]{1,12}(?::\d+(?::\d+)?)?)(?=$|[\s，。,;；:：!?！？)\]]|\.(?=\s|$))/g;
 const add=(raw:string,decode=false)=>{if(!raw)return;
  let candidate=raw.trim().replace(/^<|>$/g,'');
  if(decode&&!candidate.startsWith('file://')){try{candidate=decodeURIComponent(candidate);}catch{return;}}
  candidate=candidate.replace(/:\d+(?::\d+)?$/,'');
  try{candidate=inputPath(candidate);}catch{return;}
  if(isAbsolute(candidate)&&[tmpdir(),'/tmp','/private/tmp'].some(root=>under(resolve(candidate),resolve(root))))found.add(resolve(candidate));
 };
 for(const event of events){
  // 运行时记录的「查看图片」只有路径、没有正文引用（原文是「查看图片：<path>」），单列出来避免被正则漏掉
  if(event.image?.path)add(event.image.path);
  for(const text of [event.text,event.tool?.input,event.tool?.output]){
   if(!text)continue;
   for(const match of text.matchAll(re))add(match[1]??match[2]??match[3]!,!!match[1]);
  }
 }
 return [...found];
}
/** Resolve existing ancestors so archived/deleted worktrees still have a canonical location. */
export async function workspaceLocation(workspace:string):Promise<string>{
 let parent=workspace;const suffix:string[]=[];
 for(;;){
  try{return resolve(await realpath(parent),...suffix);}catch(e){
   if((e as NodeJS.ErrnoException).code!=='ENOENT')return fail('工作目录不可读取',404,'RT_NOT_FOUND');
   const next=dirname(parent);if(next===parent)return fail('工作目录不存在',404,'RT_NOT_FOUND');
   suffix.unshift(basename(parent));parent=next;
  }
 }
}
/** 消息里常只写「list-entry/light-390.png」「cost-light-390.png」这类省略了目录的相对路径：按工作目录根找不到时，在工作目录内找路径末尾吻合的文件，多个取最近修改的 */
const LOCATE_SKIP=new Set(['node_modules','.git','dist','.pi-worktrees','.cache','coverage']);
const LOCATE_ENTRY_LIMIT=30000;
async function locateByTail(workspace:string,input:string):Promise<string|undefined>{
 const tail=input.replace(/^\.\//,'');
 if(!tail||isAbsolute(tail)||tail.split('/').includes('..')||!/\.[a-z0-9]{1,12}$/i.test(tail))return undefined;
 const suffix=sep+tail.split('/').join(sep);let seen=0;
 let best:{path:string;mtime:number}|undefined;
 const walk=async(dir:string):Promise<void>=>{
  let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}
  for(const entry of entries){
   if(++seen>LOCATE_ENTRY_LIMIT)return;
   const full=resolve(dir,entry.name);
   if(entry.isDirectory()){if(!LOCATE_SKIP.has(entry.name))await walk(full);}
   else if(entry.isFile()&&full.endsWith(suffix)){const info=await stat(full).catch(()=>null);if(info&&(!best||info.mtimeMs>best.mtime))best={path:full,mtime:info.mtimeMs};}
  }
 };
 await walk(workspace);return best?.path;
}
/** 前文目录提示：消息里另写过的目录（如「在 docs/x/evidence/ 下」）；省略目录的相对路径先按这些目录拼，找不到再按末尾吻合找 */
export const PREVIEW_HINT_MAX=8;
const exists=(path:string)=>realpath(path).then(()=>true,()=>false);
export async function readPreviewFile(scope:FileScope,input:string,hints:readonly string[]=[]){
 if(!isAbsolute(scope.workspace))return fail('无法定位消息所属工作目录',400,'RT_INPUT');
 const workspace=await workspaceLocation(scope.workspace);
 const roots=await Promise.all(scope.roots.map(r=>realpath(r).catch(()=>'')));
 if(!roots.some(r=>r&&under(workspace,r)))return fail('工作目录已不在授权范围内');
 let target=resolve(workspace,inputPath(input));
 if(!isAbsolute(input)&&!input.startsWith('~/')&&!input.startsWith('file://')&&!await exists(target)){
  let found:string|undefined;
  for(const hint of hints.slice(0,PREVIEW_HINT_MAX)){
   if(!hint||hint.length>4096||/[\0\r\n]/.test(hint))continue;
   let candidate:string;try{candidate=resolve(workspace,inputPath(hint),input);}catch{continue;}
   if(await exists(candidate)){found=candidate;break;}
  }
  target=found??await locateByTail(workspace,input)??target;
 }
 // Ordinary previews follow the configured roots, not cwd. Temporary exceptions
 // are exact references from this session and must remain inside a real temp root.
 const path=await realpath(target).catch(()=>fail('文件不存在或没有读取权限',404,'RT_NOT_FOUND'));
 if(!roots.some(root=>root&&under(path,root))){
  const tempRoots=await Promise.all([tmpdir(),'/tmp','/private/tmp'].map(root=>realpath(root).catch(()=>'')));
  const references=await Promise.all((scope.referencedFiles??[]).map(file=>realpath(file).catch(()=>'')));
  if(!tempRoots.some(root=>root&&under(path,root))||!references.includes(path))return fail('文件不在授权读取范围内，也不是本会话引用的临时文件');
 }
 const info=await stat(path);if(!info.isFile())return fail('该地址不是文件',400,'RT_INPUT');
 if(info.size>PREVIEW_FILE_MAX)return fail('文件过大，预览上限为 25 MB',413,'FILE_TOO_LARGE');
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW).catch(()=>fail('文件不存在或没有读取权限',404,'RT_NOT_FOUND'));
 try{
  const current=await fd.stat();const again=await realpath(target).catch(()=>'');
  if(again!==path || current.dev!==info.dev || current.ino!==info.ino)return fail('文件在读取期间发生变化，请重试',409,'FILE_CHANGED');
  if(current.size>PREVIEW_FILE_MAX)return fail('文件过大，预览上限为 25 MB',413,'FILE_TOO_LARGE');
  const head=Buffer.alloc(Math.min(current.size,PREVIEW_TEXT_MAX));const {bytesRead}=await fd.read(head,0,head.length,0);const bytes=head.subarray(0,bytesRead);
  const ext=extname(path).toLowerCase();let mode='unsupported',type='application/octet-stream';
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){mode='image';type='image/png';}
  else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255){mode='image';type='image/jpeg';}
  else if(['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString())){mode='image';type='image/gif';}
  else if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'){mode='image';type='image/webp';}
  else if(bytes.subarray(0,5).toString()==='%PDF-'){mode='pdf';type='application/pdf';}
  else if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WAVE'){mode='audio';type='audio/wav';}
  else if((bytes.subarray(0,3).toString()==='ID3'||(bytes[0]===255&&(bytes[1]!&224)===224))&&ext==='.mp3'){mode='audio';type='audio/mpeg';}
  else if(bytes.subarray(4,8).toString()==='ftyp'&&['.mp4','.mov','.m4a'].includes(ext)){mode=ext==='.m4a'?'audio':'video';type=ext==='.m4a'?'audio/mp4':'video/mp4';}
  else if(bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]))&&ext==='.webm'){mode='video';type='video/webm';}
  else if(bytes.subarray(0,4).toString()==='OggS'&&ext==='.ogg'){mode='audio';type='audio/ogg';}
  else if(/^\.(txt|md|markdown|json|ya?ml|toml|ini|log|csv|tsv|[cm]?[jt]sx?|py|rb|go|rs|java|c|cpp|h|css|html?|svg|xml|sh|sql|tex|vue|svelte|conf)$/i.test(ext) || !ext){
   if(!bytes.includes(0)) {try{new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,Math.min(bytes.length,4096)),{stream:true});mode='text';type='text/plain; charset=utf-8';}catch{/* binary */}}
  }
  const meta={name:basename(path),path,type,size:current.size,modifiedAt:current.mtime.toISOString(),mode,...(mode==='text'?{text:bytes.toString('utf8'),truncated:current.size>bytesRead}:{})};
  return {meta,async content(start:number,end:number){const data=Buffer.alloc(end-start+1);const read=await fd.read(data,0,data.length,start);return data.subarray(0,read.bytesRead);},close:()=>fd.close()};
 }catch(e){await fd.close();throw e;}
}
const MEDIA_CSP="default-src 'none'; script-src 'none'; frame-ancestors 'self'";
const etagMatches=(header:string|undefined,etag:string):boolean=>!!header&&header.split(',').some(tag=>{const value=tag.trim().replace(/^W\//,'');return value==='*'||value===etag;});
const ifRangeAllows=(value:string,etag:string,mtimeMs:number):boolean=>{
 const validator=value.trim();
 if(validator.startsWith('"')||validator.startsWith('W/'))return validator.replace(/^W\//,'')===etag;
 const date=Date.parse(validator);
 return Number.isFinite(date)&&date===Math.floor(mtimeMs/1000)*1000;
};
async function readFileRange(path:string,start:number,end:number):Promise<Buffer>{
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const data=Buffer.alloc(end-start+1);const read=await fd.read(data,0,data.length,start);return data.subarray(0,read.bytesRead);}finally{await fd.close();}
}
interface MediaServe{type:string;size:number;cacheControl:string;etag?:string;mtimeMs?:number;read:(start:number,end:number)=>Promise<Buffer>}
/** 音视频共用的 Range / 条件请求；图片和 PDF 也用同一套，只是不启用缓存头。 */
async function serveMedia(c:Context,media:MediaServe){
 const headers:Record<string,string>={
  'Cache-Control':media.cacheControl,'Content-Type':media.type,'Content-Security-Policy':MEDIA_CSP,
  'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff',
  ...(media.etag?{ETag:media.etag}:{}),
  ...(media.mtimeMs!==undefined?{'Last-Modified':new Date(media.mtimeMs).toUTCString()}:{})
 };
 if(media.etag&&etagMatches(c.req.header('if-none-match'),media.etag))return c.body(null,304,headers);
 if(media.etag&&media.mtimeMs!==undefined&&!c.req.header('if-none-match')){
  const since=c.req.header('if-modified-since');
  if(since&&Number.isFinite(Date.parse(since))&&Date.parse(since)>=Math.floor(media.mtimeMs/1000)*1000)return c.body(null,304,headers);
 }
 let start=0,end=media.size-1,status:200|206=200;
 const range=c.req.header('range'),ifRange=c.req.header('if-range');
 if(range&&(!ifRange||!media.etag||ifRangeAllows(ifRange,media.etag,media.mtimeMs??0))){
  const match=/^bytes=(\d*)-(\d*)$/.exec(range);
  if(!match||(!match[1]&&!match[2]))return c.body(null,416,{...headers,'Content-Range':`bytes */${media.size}`});
  if(match[1]){start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;}else{start=Math.max(0,media.size-Number(match[2]));}
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=media.size)return c.body(null,416,{...headers,'Content-Range':`bytes */${media.size}`});
  status=206;
 }
 const bytes=await media.read(start,end);
 return c.body(new Uint8Array(bytes),status,{...headers,'Content-Length':String(bytes.length),...(status===206?{'Content-Range':`bytes ${start}-${end}/${media.size}`}:{})});
}
const HTML_FILE=/\.html?$/i;
/** HTML 预览：sandbox 不给 allow-same-origin，页面拿不到控制台的 cookie 和接口；connect/img/font 只认内联数据，不向外发请求 */
export const HTML_PREVIEW_CSP="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts";
export async function serveFilePreview(c:Context,scope:FileScope,content=false){
 let file:Awaited<ReturnType<typeof readPreviewFile>>|undefined;
 try{
  file=await readPreviewFile(scope,c.req.query('path')||'',c.req.queries('hint')??[]);
  const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
  if(!content)return c.json(file.meta,200,headers);
  // HTML 文件按网页显示：放进沙箱（不同源、不能联网、不能弹窗或跳走），只允许页面自带的内联脚本和样式
  if(file.meta.mode==='text'&&HTML_FILE.test(file.meta.path)){
   const bytes=await file.content(0,file.meta.size-1);
   return c.body(new Uint8Array(bytes),200,{...headers,'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':HTML_PREVIEW_CSP,'Referrer-Policy':'no-referrer','Content-Length':String(bytes.length)});
  }
  if(!['image','pdf','audio','video'].includes(file.meta.mode))return c.json({error:'该格式不提供原始内容预览',code:'FILE_UNSUPPORTED'},415,headers);
  // ?size=thumb|view：图片压缩成 WebP 再传（公网访问时原图太慢）；不带 size 仍是原图
  const size=file.meta.mode==='image'?imageSizeParam(c.req.query('size')):undefined;
  if(size){
   const opened=file,meta=file.meta;
   const etag=`W/"${size}-${meta.size}-${Date.parse(meta.modifiedAt)}"`;
   const cacheHeaders={'Cache-Control':'private, no-cache','X-Content-Type-Options':'nosniff',ETag:etag};
   if(c.req.header('if-none-match')===etag)return c.body(null,304,cacheHeaders);
   const out=await compressImage(`${meta.path}|${meta.size}|${meta.modifiedAt}`,meta.type,size,()=>opened.content(0,meta.size-1));
   return c.body(new Uint8Array(out.bytes),200,{...cacheHeaders,...compressedImageHeaders(out),'Content-Type':out.mimeType,'Content-Security-Policy':"default-src 'none'; script-src 'none'; frame-ancestors 'self'",'Content-Length':String(out.bytes.length)});
  }
  const opened=file,meta=file.meta,modified=Date.parse(meta.modifiedAt);
  // 视频：?size=preview 先转 720p30（结果缓存），手机弱网只传 1/5 左右的数据量。
  if(meta.mode==='video'&&videoPreviewParam(c.req.query('size'))){
   const preview=await makeVideoPreview(meta.path,meta.size,modified);
   if(preview)try{
    return await serveMedia(c,{type:preview.mimeType,size:preview.size,cacheControl:'private, max-age=3600',
     etag:`"p-${meta.size.toString(16)}-${Math.floor(modified).toString(16)}"`,mtimeMs:modified,
     read:(start,end)=>readFileRange(preview.path,start,end)});
   }catch{/* 预览文件被清理或读不到：回退原片，不让预览失败 */}
  }
  const cacheable=meta.mode==='video'||meta.mode==='audio';
  return await serveMedia(c,{type:meta.type,size:meta.size,
   cacheControl:cacheable?'private, max-age=300':'private, no-store',
   ...(cacheable?{etag:`"${meta.size.toString(16)}-${Math.floor(modified).toString(16)}"`,mtimeMs:modified}:{}),
   read:(start,end)=>opened.content(start,end)});
 }catch(e){if(e instanceof RuntimeError || e instanceof FilePreviewError)return c.json({error:e.message,code:e.code},e.status);return c.json({error:'文件不可读取，请检查权限或重试',code:'FILE_UNAVAILABLE'},404);}
 finally{await file?.close();}
}
