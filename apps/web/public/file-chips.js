"use strict";
/* V3.5 file references are presentation only. Reads happen only on activation —— 唯一例外：SVG / .mmd / .puml 引用进入视野后读一次文件来画缩略图（diagram-preview.js），走同一个受授权范围限制的 file-preview 接口。 */
let fileRenderContext;
/** 末段没有扩展名的路径是目录（临时工作区、docs/x 这类），服务端只能预览文件：不做成可点胶囊，按普通文本显示 */
const FILE_EXTENSIONLESS=/^(?:Makefile|Dockerfile|LICENSE|LICENCE|README|CHANGELOG|Procfile|Gemfile|Rakefile|Jenkinsfile|Vagrantfile|CODEOWNERS|Doxyfile|BUILD|WORKSPACE)$/i;
function fileHasExtension(path){const name=String(path||'').split('/').pop()||'';return /\.[A-Za-z0-9]{1,12}$/.test(name)||FILE_EXTENSIONLESS.test(name);}
function fileReference(raw, explicit=false, decodeLink=false) {
 let path=String(raw||'').trim().replace(/^<|>$/g,'');
 if(!path || path.startsWith('#') || (/^[a-z][a-z0-9+.-]*:/i.test(path)&&!/^file:\/\//i.test(path)) || path.endsWith('/'))return null;
 if(decodeLink&&!/^file:\/\//i.test(path)){try {path=decodeURIComponent(path);}catch{}}
 const match=/:(\d+)(?::\d+)?$/.exec(path),line=match?Number(match[1]):undefined;
 if(match)path=path.slice(0,match.index);
 if(!explicit&&!/^(?:\/|~\/|file:\/\/|\.\.?\/)|^[\w\-.一-龥]+\/[\w\-./一-龥]+/.test(path))return null;
 if(!/^(?:\/|~\/|file:\/\/|\.\.?\/)/.test(path)&&!path.includes('.')&&!path.includes('/'))return null;
 if(!fileHasExtension(path))return null;
 return {path,line};
}
/** 行内代码里只写了图片文件名（没有目录）：也当作文件引用，点开时服务端会在工作目录内按文件名找 */
function fileInlineCodeReference(value){
 const ref=fileReference(value);if(ref)return ref;
 const name=String(value||'').trim();
 return /^[\w\-.一-龥]+\.(?:png|jpe?g|gif|webp)$/i.test(name)?{path:name}:null;
}
/** 消息里另外写过的目录（行内代码或链接里带「/」的片段；结尾是「/」就是目录本身，否则取文件所在目录），最近的在前。省略了目录的相对路径读取时先按这些目录拼（与 image-index.ts 的 directoryHints 同规则） */
function fileDirectoryHints(text){
 const found=[],take=(raw,index,decode)=>{
  let token=String(raw).trim().replace(/^<|>$/g,'');
  try{if(token.startsWith('file://'))token=decodeURIComponent(token.slice(7));else if(decode)token=decodeURIComponent(token);}catch{return;}
  token=token.replace(/:\d+(?::\d+)?$/,'');
  if(!token.includes('/')||token.length>1024||/[\s*<>|?]|^[a-z][a-z0-9+.-]*:/i.test(token)||token.startsWith('..'))return;
  const dir=token.endsWith('/')?token:/\.[A-Za-z0-9]{1,12}$/.test(token)?token.slice(0,token.lastIndexOf('/'))||'/':'';
  const clean=dir.replace(/^\.\//,'').replace(/\/+$/,'');
  if(clean&&clean!=='.'&&!clean.startsWith('..'))found.push({dir:clean,index});
 };
 const s=String(text||'');
 for(const m of s.matchAll(/`([^`\n]+)`/g))take(m[1],m.index,false);
 for(const m of s.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g))take(m[1],m.index,true);
 return [...new Set(found.sort((a,b)=>b.index-a.index).map(x=>x.dir))].slice(0,8);
}
function fileType(path){
 const ext=(path.split('.').pop()||'').toLowerCase();
 for(const [type,extensions] of Object.entries({image:['png','jpg','jpeg','gif','webp','svg','avif'],pdf:['pdf'],document:['doc','docx','odt','rtf'],sheet:['xls','xlsx','csv','tsv'],slides:['ppt','pptx'],audio:['mp3','wav','m4a','ogg'],video:['mp4','webm','mov'],archive:['zip','tar','gz','7z'],code:['js','ts','jsx','tsx','py','json','yaml','yml','html','htm','css','svg','sh','go','rs','c','cpp','java'],text:['md','txt','log','tex']}))if(extensions.includes(ext))return type;
 return 'file';
}
function fileIcon(type){
 const paths={image:'M3 3h18v18H3z M3 16l6-6 5 5 3-3 4 4 M15 7h.01',pdf:'M5 2h9l5 5v15H5z M14 2v6h5 M8 12h8 M8 16h6',document:'M5 2h9l5 5v15H5z M8 12h8 M8 16h8 M8 19h5',sheet:'M3 3h18v18H3z M3 9h18 M3 15h18 M9 3v18',slides:'M3 4h18v13H3z M12 17v5 M7 22h10 M7 8h10 M7 12h5',audio:'M9 18V5l11-2v13 M9 5v5l11-2 M9 18c0 3-6 4-6 1s6-4 6-1 M20 16c0 3-6 4-6 1s6-4 6-1',video:'M3 5h13v14H3z M16 10l5-4v12l-5-4',archive:'M5 2h14v20H5z M12 2v12 M10 14h4v4h-4z',code:'M8 7l-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16',text:'M5 2h14v20H5z M8 7h8 M8 12h8 M8 17h6',file:'M5 2h9l5 5v15H5z M14 2v6h5'};
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 for(const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'}))svg.setAttribute(key,value);
 const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',paths[type]||paths.file);svg.append(path);return svg;
}
/* 渲染前预检：胶囊先照常显示，服务端（和点开时同一套定位 + 授权判断）确认读不到，就换成不可点的灰字——不可点的东西不该长得像按钮。
   预检请求失败、结果缺失一律不动胶囊（宁可多一个点不开的，也不误伤能开的）。 */
const FILE_CHECK_OK_MS=120000,FILE_CHECK_BAD_MS=8000,FILE_CHECK_BATCH=20;
const fileCheckCache=new Map(),fileCheckWaiting=new Map(),fileCheckInflight=new Map();let fileCheckTimer=0;
function fileChipUnavailable(el,reason){
 const path=el.getAttribute('data-file-path')||'',label=el.getAttribute('aria-label')?.match(/^预览 (.*?)：/)?.[1]||path.split('/').pop();
 return h('span',{class:'file-chip-unavailable','data-file-unavailable':'true','data-file-path':path,title:`${reason||'文件读不到'}：${path}`},label);
}
function fileCheckFlush(){
 fileCheckTimer=0;const groups=new Map();
 for(const [key,entry] of fileCheckWaiting){let g=groups.get(entry.base);if(!g)groups.set(entry.base,g=[]);g.push([key,entry]);}
 for(const [key,entry] of fileCheckWaiting)fileCheckInflight.set(key,entry);
 fileCheckWaiting.clear();
 for(const [base,items] of groups)for(let i=0;i<items.length;i+=FILE_CHECK_BATCH){
  const chunk=items.slice(i,i+FILE_CHECK_BATCH);
  const query=new URLSearchParams();for(const [,entry] of chunk)query.append('ref',JSON.stringify({path:entry.path,hints:entry.hints}));
  if(chunk[0][1].memberId)query.set('memberId',chunk[0][1].memberId);
  fetch(`${base}/file-check?${query}`,{credentials:'same-origin'}).then(r=>r.ok?r.json():null).then(data=>{
   const files=Array.isArray(data?.files)?data.files:null;
   chunk.forEach(([key,entry],index)=>{
    const result=files?.[index];if(!result||typeof result.ok!=='boolean')return;
    fileCheckCache.set(key,{ok:result.ok,reason:result.reason,at:Date.now()});
    for(const waiter of entry.waiters)waiter(result);
   });
  }).catch(()=>{}).finally(()=>{for(const [key] of chunk)fileCheckInflight.delete(key);});
 }
}
function fileWatchAvailability(el,context){
 const base=fileBase(context),path=el.getAttribute?.('data-file-path');
 if(!base||!path||context?.inert||typeof fetch!=='function')return el;
 let hints=[];try{hints=JSON.parse(el.getAttribute('data-file-hints')||'[]')||[];}catch{}
 const key=`${base}|${context?.memberId||''}|${path}|${hints.join('\n')}`;
 const apply=result=>{if(result.ok||!el.parentNode)return;el.replaceWith(fileChipUnavailable(el,result.reason));};
 const hit=fileCheckCache.get(key);
 if(hit&&Date.now()-hit.at<(hit.ok?FILE_CHECK_OK_MS:FILE_CHECK_BAD_MS)){if(!hit.ok)setTimeout(()=>apply(hit),0);return el;}
 let entry=fileCheckWaiting.get(key)||fileCheckInflight.get(key);
 if(!entry)fileCheckWaiting.set(key,entry={base,path,hints,memberId:context?.memberId,waiters:[]});
 entry.waiters.push(apply);
 if(!fileCheckTimer)fileCheckTimer=setTimeout(fileCheckFlush,40);
 return el;
}
function fileChip(reference,context=fileRenderContext){return fileWatchAvailability(fileChipBuild(reference,context),context);}
function fileChipBuild(reference,context=fileRenderContext){
 // 缩略图里的引用只当文字：缩略图本身就是一个按钮，不能再套按钮，也不该在这里被点
 if(context?.inert)return h('span',{class:'file-chip-inert'},reference.label||String(reference.path||'').split('/').pop());
 if(context?.baseDir&&!/^(?:\/|~\/|file:\/\/)/i.test(reference.path))reference={...reference,path:fileResolveRelative(reference.path,context.baseDir)};
 // 省略了目录的相对路径：带上同一条消息里写过的目录，点开时服务端先按这些目录找
 else if(context?.hints?.length&&!reference.hints&&!/^(?:\/|~\/|file:\/\/)/i.test(reference.path))reference={...reference,hints:context.hints};
 // SVG / Mermaid / PlantUML 文件：胶囊里直接显示缩略图，点击用图片查看器放大（diagram-preview.js）
 const diagram=context?.thumbs!==false&&typeof diagramKindForPath==='function'?diagramKindForPath(reference.path):null;
 if(diagram&&fileBase(context)&&typeof diagramFileChip==='function')return diagramFileChip(reference,context,diagram);
 const type=fileType(reference.path),name=reference.path.split('/').pop();
 // md / html：和图片一样给一帧缩略预览（md 按排版、html 按网页），点开才是完整预览半屏
 // 预览半屏里的文档链接不再生成缩略图（避免自己套自己、也省掉来回读文件）
 const docKind=context?.thumbs===false||context?.docThumbs===false||!fileBase(context)?null:FILE_MARKDOWN.test(reference.path)?'md':FILE_HTML.test(reference.path)&&context?.sessionId?'html':null;
 if(docKind)return docThumbChip(reference,context,docKind,type);
 // 位图引用：消息里直接显示缩略图（压缩 WebP），点击进放大查看器；读不到再退回文字胶囊
 const thumbUrl=context?.thumbs!==false&&FILE_ZOOM_IMAGE.test(reference.path)?fileImageUrl(reference.path,context,'thumb',reference.hints):null;
 if(thumbUrl){
  const img=h('img',{src:thumbUrl,alt:reference.label||name,loading:'lazy',decoding:'async',draggable:'false'});
  const button=h('button',{type:'button',class:'file-chip file-chip-image','data-file-type':type,'data-file-path':reference.path,'data-file-hints':reference.hints?.length?JSON.stringify(reference.hints):null,title:reference.path,'aria-label':`预览 ${reference.label||name}：${reference.path}`,onclick:ev=>openFilePreview(reference,context,ev.currentTarget)},img);
  img.addEventListener('error',()=>button.replaceWith(fileChip(reference,{...context,thumbs:false})),{once:true});
  return button;
 }
 return fileChipPlainBuild(reference,context,type);
}
/** 退回的普通胶囊（缩略图读不到时）同样要预检：它是新建的元素，不在原来那次预检的范围里 */
function fileChipPlain(reference,context=fileRenderContext,type=fileType(reference.path)){return fileWatchAvailability(fileChipPlainBuild(reference,context,type),context);}
function fileChipPlainBuild(reference,context=fileRenderContext,type=fileType(reference.path)){
 const name=reference.path.split('/').pop();
 return h('button',{type:'button',class:'file-chip','data-file-type':type,'data-file-path':reference.path,'data-file-hints':reference.hints?.length?JSON.stringify(reference.hints):null,title:reference.path,'aria-label':`预览 ${reference.label||name}：${reference.path}`,onclick:ev=>openFilePreview(reference,context,ev.currentTarget)},fileIcon(type),h('span',{class:'file-chip-label'},reference.label||name),reference.line?h('span',{class:'file-chip-line'},`:${reference.line}`):null);
}
function filePlainParts(text,context=fileRenderContext){
 const s=String(text||''),out=[];
 // Spaces require quotes or Markdown links, so prose is never consumed as a path.
 const re=/(?<![\w:/.])(?:[`"']([^`"'\n]+)[`"']|((?:file:\/\/|~\/|\/|\.\.?\/|[\w一-龥.-]+\/)[^\s<>`"'|()\[\]，。；！？;,]*?\.[a-zA-Z0-9]{1,12}(?::\d+(?::\d+)?)?)(?=$|[\s，。,;；:：!?！？)\]]))/g;
 const remote=[...s.matchAll(/\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi)];
 let last=0;
 for(const m of s.matchAll(re)){
  if(remote.some(url=>m.index>=url.index&&m.index<url.index+url[0].length))continue;
  const ref=fileReference(m[1]||m[2]);if(!ref)continue;
  out.push(s.slice(last,m.index),fileChip(ref,context));last=m.index+m[0].length;
 }
 out.push(s.slice(last));return out;
}
function fileTextParts(text,context=fileRenderContext){
 const s=String(text||''),out=[];let last=0;
 const re=/!?\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)/g;
 for(const m of s.matchAll(re)){
  const ref=fileReference(m[2],true,true);if(!ref)continue;
  out.push(...filePlainParts(s.slice(last,m.index),context),fileChip({...ref,label:m[1]},context));last=m.index+m[0].length;
 }
 out.push(...filePlainParts(s.slice(last),context));return out;
}
function fileCodeReferences(code,context=fileRenderContext){
 // 代码块 / 工具输出下面的引用只是一排小标签，不展开缩略图
 const parts=fileTextParts(code,{...context,thumbs:false}),chips=parts.filter(p=>p instanceof Node);
 return chips.length?h('div',{class:'file-code-refs'},chips):null;
}
function fileDecorate(container,context){
 const walker=document.createTreeWalker(container,NodeFilter.SHOW_TEXT),nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
 for(const node of nodes){if(node.parentElement.closest('button,a,pre,code'))continue;const parts=fileTextParts(node.textContent,context);if(parts.some(x=>x instanceof Node))node.replaceWith(...parts.map(p=>p instanceof Node?p:document.createTextNode(p)));}
 return fileLayoutPreviews(container);
}
/** 大预览独占一行；表格、代码和缩略图内部保留原排版。原文分隔符保留在 DOM，避免复制丢字。 */
function fileLayoutPreviews(container){
 for(const card of container.querySelectorAll('.file-chip-doc,.file-chip-image,.file-chip-diagram')){
  if(card.closest('td,th,pre,code,.doc-thumb-page'))continue;
  card.classList.add('file-preview-block');
  const next=card.nextSibling;
  if(next?.nodeType===Node.TEXT_NODE){
   const match=/^[\s、，,。；;]+/.exec(next.textContent);
   if(match&&/[、，,。；;]/.test(match[0])){
    const separator=h('span',{class:'file-preview-separator','aria-hidden':'true'},match[0]);
    next.before(separator);next.textContent=next.textContent.slice(match[0].length);
   }
  }
 }
 return container;
}
let filePreviewGeneration=0,filePreviewClose,filePreviewTrigger;
function fileBase(context){return context?.sessionId?`/api/runtime-sessions/${encodeURIComponent(context.sessionId)}`:context?.roomId?`/api/rooms/${encodeURIComponent(context.roomId)}`:null;}
/** 服务端能按位图读取的图片（SVG 按文本预览，AVIF 不识别） */
const FILE_ZOOM_IMAGE=/\.(png|jpe?g|gif|webp)$/i;
/** 图片地址：size=thumb 消息内嵌缩略图、size=view 放大查看（都压缩成 WebP）；不带 size 是原图 */
function fileImageUrl(path,context,size,hints){
 const base=fileBase(context);if(!base)return null;
 const query=new URLSearchParams({path,...(context?.memberId?{memberId:context.memberId}:{}),...(size?{size}:{})});
 for(const hint of hints||[])query.append('hint',hint);
 return `${base}/file-content?${query}`;
}
/** 图片直接进放大查看器（和看上传图片一样能缩放、拖动）；同一条消息里的其他图片可左右切换 */
function openImageReference(ref,context,trigger){
 if(typeof openImageZoom!=='function'||!FILE_ZOOM_IMAGE.test(ref.path)||!fileBase(context))return false;
 if(context?.sessionId && typeof rtOpenSessionImages==='function' && rtOpenSessionImages(context.sessionId,{src:fileImageUrl(ref.path,context,'view',ref.hints),original:fileImageUrl(ref.path,context,undefined,ref.hints),name:ref.path.split('/').pop(),kind:'file',path:ref.path,...(ref.hints?.length?{hints:ref.hints}:{})},trigger))return true;
 const scope=trigger?.closest?.('.rt-row,.room-bubble'),paths=[],hintsOf={};
 for(const chip of scope?scope.querySelectorAll('.file-chip[data-file-type="image"]'):[]){const p=chip.getAttribute('data-file-path');if(p&&FILE_ZOOM_IMAGE.test(p)&&!paths.includes(p)){paths.push(p);try{hintsOf[p]=JSON.parse(chip.getAttribute('data-file-hints')||'null')||undefined;}catch{}}}
 if(!paths.includes(ref.path)){paths.splice(0,paths.length,ref.path);hintsOf[ref.path]=ref.hints;}
 openImageZoom(paths.map(path=>({src:fileImageUrl(path,context,'view',hintsOf[path]),original:fileImageUrl(path,context,undefined,hintsOf[path]),name:path.split('/').pop(),kind:'file',path})),paths.indexOf(ref.path),{
  ...(context?.sessionId&&window.piArtifactCollect?{tagControl:(item,helpers)=>window.piArtifactCollect.control({kind:'image',title:item.name,source:{type:'file',sessionId:context.sessionId,path:item.path,...(hintsOf[item.path]?.length?{hints:hintsOf[item.path]}:{}),name:item.name},variant:'dark',capture:helpers.capture})}:{}),
 });
 return true;
}
/** Markdown 文件里的相对链接按这个文件所在目录解析（context.baseDir） */
function fileResolveRelative(path,baseDir){
 if(!baseDir||/^(?:\/|~\/|file:\/\/)/i.test(path))return path;
 const abs=baseDir.startsWith('/'),parts=baseDir.split('/').filter(Boolean);
 for(const seg of path.split('/')){if(seg==='..'){if(parts.length&&parts[parts.length-1]!=='..')parts.pop();else if(!abs)parts.push('..');}else if(seg&&seg!=='.')parts.push(seg);}
 return (abs?'/':'')+parts.join('/');
}
const FILE_MARKDOWN=/\.(md|markdown|mdx)$/i,FILE_HTML=/\.html?$/i;
/* ------------------------------ 消息里的文档缩略图：md / html ------------------------------ */
/**
 * md / html 的文件引用在消息里给一帧缩略预览（与图片缩略图同尺寸），点开才是完整预览半屏。
 * - md：读文件开头，用现有 rtMarkdown 按 320 宽排版后整体缩到卡片宽；
 * - html：服务端给一帧静态快照（内联同目录样式与图片、去掉脚本、不联网），沙箱 iframe 缩放显示。
 * 只有滚到视野附近才加载，同一份内容只读一次；读不到就退回原来的图标胶囊。
 */
const DOC_THUMB_PAGE_WIDTH=320,DOC_HTML_PAGE_WIDTH=1280,DOC_HTML_PAGE_HEIGHT=768,DOC_THUMB_TEXT_MAX=200000;
const DOC_THUMB_CACHE_MAX=60,DOC_THUMB_TIMEOUT=12000;
const docThumbTexts=new Map(),docThumbStarts=new WeakMap(),docThumbFits=new WeakMap();
let docThumbChain=Promise.resolve(),docThumbObserver=null,docThumbResizeObserver=null;

/** 一条消息里可能有十来个文档引用：缩略图排队渲染，不同时抢带宽；一个卡住也不会把后面的全堵死 */
function docThumbQueued(run){
 const next=docThumbChain.then(run,run);
 docThumbChain=next.then(()=>{},()=>{});
 let timer;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('缩略图渲染超时')),DOC_THUMB_TIMEOUT);});
 return Promise.race([next,timeout]).finally(()=>clearTimeout(timer));
}
/** 滚到视野附近（含 320px 预量）再开始渲染 */
function docThumbWhenVisible(card,start){
 if(typeof IntersectionObserver!=='function'){start();return;}
 if(!docThumbObserver)docThumbObserver=new IntersectionObserver(entries=>{
  for(const entry of entries){if(!entry.isIntersecting)continue;docThumbObserver.unobserve(entry.target);const run=docThumbStarts.get(entry.target);docThumbStarts.delete(entry.target);run?.();}
 },{rootMargin:'320px 0px'});
 docThumbStarts.set(card,start);docThumbObserver.observe(card);
}
function docThumbWatchFit(frame,fit){
 docThumbFits.set(frame,fit);fit();
 if(typeof ResizeObserver!=='function')return;
 if(!docThumbResizeObserver)docThumbResizeObserver=new ResizeObserver(entries=>{for(const entry of entries)docThumbFits.get(entry.target)?.();});
 docThumbResizeObserver.observe(frame);
}
/** 页面按虚拟宽度排好，再等比缩到卡片宽度（宽度变化时重算，横竖屏切换也不会错位） */
function docThumbFit(frame,page,pageWidth,pageHeight){
 page.style.width=pageWidth+'px';
 if(pageHeight)page.style.height=pageHeight+'px';
 frame.replaceChildren(page);
 docThumbWatchFit(frame,()=>{
  // Markdown 随加宽后的卡片重新排版，避免桌面卡片右侧留下大块空白；HTML 保持固定视口快照。
  const width=frame.clientWidth||220,layoutWidth=pageHeight?pageWidth:Math.max(pageWidth,width);
  page.style.width=layoutWidth+'px';
  const scale=Math.max(.05,Math.min(1,width/layoutWidth));page.style.transform=`scale(${scale.toFixed(4)})`;
 });
}
function docThumbUrl(reference,context,path){
 const query=new URLSearchParams({path:reference.path,...(context?.memberId?{memberId:context.memberId}:{})});
 for(const hint of reference.hints||[])query.append('hint',hint);
 return `${fileBase(context)}${path}?${query}`;
}
function docThumbMarkdownText(reference,context){
 const key=`${fileBase(context)}|${reference.path}`;
 const hit=docThumbTexts.get(key);if(hit)return hit;
 const promise=docThumbQueued(async()=>{
  const data=await api(docThumbUrl(reference,context,'/file-preview'));
  if(!data||data.mode!=='text'||typeof data.text!=='string'||!data.text.trim())throw new Error('文件不可预览');
  return data.text.slice(0,DOC_THUMB_TEXT_MAX);
 });
 docThumbTexts.set(key,promise);
 promise.catch(()=>docThumbTexts.delete(key));
 // 只留最近的若干份：长会话里翻过的文档不会一直占着内存
 for(const old of docThumbTexts.keys()){if(docThumbTexts.size<=DOC_THUMB_CACHE_MAX)break;if(old!==key)docThumbTexts.delete(old);}
 return promise;
}
function docThumbMarkdownPage(reference,context,text){
 const dir=reference.path.includes('/')?reference.path.slice(0,reference.path.lastIndexOf('/'))||'/':'';
 // 缩略图里不再展开图片 / 文档缩略图，写成普通小胶囊就行
 const doc=typeof rtMarkdown==='function'?rtMarkdown(text,{...context,baseDir:dir,thumbs:false,docThumbs:false,inert:true,streaming:false}):h('div',{},text.slice(0,4000));
 doc.classList.add('doc-thumb-page');doc.setAttribute('aria-hidden','true');
 // 缩略图只是一帧画面：不可聚焦、不可点（里面的链接和引用不停在这里）
 if('inert' in doc)doc.inert=true;
 return doc;
}
function docThumbHtmlPage(reference,context){
 return h('iframe',{class:'doc-thumb-html',title:'',tabindex:'-1','aria-hidden':'true',loading:'lazy',sandbox:'',referrerpolicy:'no-referrer',src:docThumbUrl(reference,context,'/files/thumb')});
}
function docThumbChip(reference,context,kind,type){
 const label=reference.label||reference.path.split('/').pop();
 const frame=h('span',{class:'file-chip-doc-frame'},h('span',{class:'file-chip-doc-pending','aria-hidden':'true'},'预览中…'));
 const card=h('button',{type:'button',class:'file-chip file-chip-doc','data-doc-thumb':kind,'data-file-type':type,'data-file-path':reference.path,'data-file-hints':reference.hints?.length?JSON.stringify(reference.hints):null,title:`${kind==='html'?'网页':'Markdown'}预览：${reference.path}`,'aria-label':`预览 ${label}：${reference.path}`,onclick:ev=>openFilePreview(reference,context,ev.currentTarget)},
  frame,
  h('span',{class:'file-chip-doc-foot'},h('span',{class:'file-chip-doc-kind'},kind==='html'?'HTML':'MD'),h('span',{class:'file-chip-doc-name'},label)));
 const fallback=()=>{if(card.isConnected)card.replaceWith(fileChipPlain(reference,context,type));};
 docThumbWhenVisible(card,()=>{
  if(kind==='html'){docThumbFit(frame,docThumbHtmlPage(reference,context),DOC_HTML_PAGE_WIDTH,DOC_HTML_PAGE_HEIGHT);return;}
  docThumbMarkdownText(reference,context).then(text=>{
   if(!card.isConnected||card.dataset.docFilled)return;
   card.dataset.docFilled='1';docThumbFit(frame,docThumbMarkdownPage(reference,context,text),DOC_THUMB_PAGE_WIDTH);
  }).catch(fallback);
 });
 return card;
}
/** 文本按行显示：带行号，可选自动换行，ref.line 那一行高亮 */
function filePreviewLines(text,line,wrap){
 return h('pre',{class:`file-preview-text${wrap?' wrap':''}`},text.split('\n').map((l,i)=>h('div',{class:`file-preview-line${line===i+1?' active':''}`},h('span',{class:'file-preview-number','aria-hidden':'true'},String(i+1)),h('span',{class:'file-preview-code'},l||' '))));
}
function filePreviewTime(iso){
 const d=new Date(iso);if(Number.isNaN(d.getTime()))return '';
 return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(d);
}
function filePreviewSize(n){return !Number.isFinite(n)?'':n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;}
/** 手机底部浮层：按住顶部往下拖超过一段距离就关闭 */
function filePreviewSwipe(handle,panel,close){
 let startY=null,dy=0;
 handle.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'||e.target.closest('button')||!matchMedia('(max-width: 700px)').matches)return;startY=e.clientY;dy=0;panel.style.transition='none';handle.setPointerCapture?.(e.pointerId);});
 handle.addEventListener('pointermove',e=>{if(startY===null)return;dy=Math.max(0,e.clientY-startY);panel.style.transform=dy?`translateY(${dy}px)`:'';});
 const end=()=>{if(startY===null)return;startY=null;panel.style.transition='';if(dy>90)close();else panel.style.transform='';};
 handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
}
/** 文件预览的来源：聊天里是当前消息行，产物里是已保存的 source。 */
function fileArtifactSource(ref,context,trigger){
 if(context?.artifactSource)return context.artifactSource;
 if(!context?.sessionId)return null;
 const row=trigger?.closest?.('.rt-row[data-ev-key]')||filePreviewTrigger?.closest?.('.rt-row[data-ev-key]'),name=ref.path.split('/').pop();
 return {type:'file',sessionId:context.sessionId,path:ref.path,...(ref.hints?.length?{hints:ref.hints}:{}),name,...(row?.dataset.evKey?{eventKey:row.dataset.evKey}:{}),...(Number(row?.dataset.evSeq)?{eventSeq:Number(row.dataset.evSeq)}:{})};
}
async function openFilePreview(ref,context,trigger){
 if(openImageReference(ref,context,trigger))return;
 // 预览里的 Markdown 链接点开新文件时替换当前面板，焦点仍回到最初的消息
 const origin=trigger?.closest?.('.file-preview-dialog')?filePreviewTrigger:trigger;
 filePreviewClose?.(false);const generation=++filePreviewGeneration;filePreviewTrigger=origin;
 const name=ref.path.split('/').pop(),type=fileType(ref.path),markdown=FILE_MARKDOWN.test(ref.path),html=FILE_HTML.test(ref.path);
 // 产物入口：文件预览从聊天打开时加入，从产物打开时编辑；回到会话只在从产物打开时出现（聊天里本来就在这里）。
 const fromArtifact=!!context?.artifactSource;
 const artifactSource=context?.artifactSource||fileArtifactSource(ref,context,trigger);
 const artifactKind=html||markdown?'document':type==='video'?'video':type==='image'?'image':null;
 const canCollect=!!(artifactSource&&artifactKind&&window.piArtifactCollect);
 // Markdown 默认排版、HTML 默认按网页显示；引用带行号时先看原文
 const state={view:(markdown||html)&&!ref.line?'rendered':'raw',wrap:type!=='code',data:null};
 const body=h('div',{class:'file-preview-body'},h('p',{role:'status',class:'muted'},'正在读取…'));
 const meta=h('p',{class:'file-preview-meta',title:'显示文件当前内容，不是消息发出时的快照'},'当前内容');
 const viewBtn=h('button',{type:'button',class:'btn small ghost file-preview-toggle',hidden:true,onclick:()=>{state.view=state.view==='rendered'?'raw':'rendered';render();}});
 const wrapBtn=h('button',{type:'button',class:'btn small ghost file-preview-toggle',hidden:true,onclick:()=>{state.wrap=!state.wrap;render();}});
 const openLink=h('a',{class:'btn small ghost file-preview-open',target:'_blank',rel:'noopener noreferrer',hidden:true,title:'在新窗口打开网页（同样在沙箱里）'},'新窗口');
 const copyBtn=h('button',{type:'button',class:'btn small ghost file-preview-copy',onclick:()=>{navigator.clipboard?.writeText(ref.path).then(()=>{copyBtn.textContent='已复制';setTimeout(()=>{copyBtn.textContent='复制路径';},1500);}).catch(()=>{});}},'复制路径');
 const close=(restoreFocus=true)=>{if(generation===filePreviewGeneration)filePreviewGeneration++;dialog.close();dialog.remove();if(filePreviewClose===close)filePreviewClose=null;if(restoreFocus&&origin?.isConnected)origin.focus();};
 // 头部两行：文件名 + 操作按钮；路径 + 大小/修改时间（手机全屏时尽量少占高度）
 const head=h('header',{class:'file-preview-head'},
  h('div',{class:'file-preview-title'},h('span',{class:'file-preview-icon','data-file-type':type},fileIcon(type)),h('strong',{title:name},name)),
  h('div',{class:'file-preview-tools'},viewBtn,wrapBtn,openLink,copyBtn,h('button',{type:'button',class:'btn small ghost file-preview-close','aria-label':'关闭',onclick:()=>close()},'关闭')),
  h('p',{class:'file-preview-path',title:ref.path},h('bdi',{},ref.path)),meta);
 const panel=h('div',{class:'file-preview-panel'},head,body);
 /* 产物：右下角常驻控件；图片把当前画面交给打标，文档只带正文节选（服务端截前 800 字）。 */
 let mediaNode=null;
 const control=canCollect&&typeof window.piArtifactCollect?.control==='function'?window.piArtifactCollect.control({
  kind:artifactKind,title:name,source:artifactSource,variant:'light',
  ...(artifactKind==='image'?{capture:()=>window.piArtifactCollect.captureImageElement(mediaNode)}:{}),
  ...(artifactKind==='document'?{excerpt:()=>state.data?.mode==='text'?state.data.text:''}:{}),
  actions:fromArtifact?[{label:'回到会话',onClick:()=>{close(false);void window.piArtifactCollect.returnToSession(artifactSource);}}]:[],
 }):null;
 const dialog=h('dialog',{class:'file-preview-dialog','aria-label':'文件预览','data-markdown':markdown?'true':null,'data-html':html?'true':null},panel);
 if(control){
  dialog.classList.add("has-artifact-footer");panel.append(control);
  if(fromArtifact){
   const tools=h('div',{class:'artifact-preview-tools'},viewBtn,wrapBtn,openLink,copyBtn);
   control.append(tools);
  }
 }
 dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
 // 点浮层外的遮罩关闭（dialog 本身没有内边距，点到它自己就是点在遮罩上）
 dialog.addEventListener('click',e=>{if(e.target===dialog)close();});
 filePreviewSwipe(head,panel,()=>close());
 document.body.append(dialog);dialog.showModal();filePreviewClose=close;
 const base=fileBase(context);
 const query=new URLSearchParams({path:ref.path,...(context?.memberId?{memberId:context.memberId}:{})});
 for(const hint of ref.hints||[])query.append('hint',hint);
 function render(){
  const data=state.data;if(!data||data.mode!=='text')return;
  const rendered=(markdown||html)&&state.view==='rendered';
  viewBtn.hidden=!markdown&&!html;viewBtn.textContent=html?(rendered?'看源码':'看网页'):(rendered?'看原文':'看排版');
  openLink.hidden=!(html&&rendered);
  wrapBtn.hidden=rendered;wrapBtn.textContent=state.wrap?'不换行':'自动换行';
  dialog.toggleAttribute('data-rendered',rendered);
  const notice=data.truncated?h('p',{class:'file-preview-notice'},'文件较大，仅显示前 1 MB'):null;
  if(rendered&&html){
   // 网页放进沙箱 iframe：服务端同时下发 sandbox CSP，页面不同源、不能联网、拿不到控制台的登录状态
   const url=`${base}/file-content?${query}`;openLink.href=url;
   body.replaceChildren(h('iframe',{class:'file-preview-html',src:url,title:`网页预览：${name}`,sandbox:'allow-scripts',referrerpolicy:'no-referrer'}));
  }else if(rendered){
   const dir=ref.path.includes('/')?ref.path.slice(0,ref.path.lastIndexOf('/'))||'/':'';
   const doc=typeof rtMarkdown==='function'?rtMarkdown(data.text,{...context,baseDir:dir,foldCode:false,docThumbs:false}):h('div',{},data.text);
   doc.classList.add('file-preview-doc');body.replaceChildren(notice||'',doc);body.scrollTop=0;
  }else{
   const code=filePreviewLines(data.text,ref.line,state.wrap);body.replaceChildren(notice||'',code);
   requestAnimationFrame(()=>code.querySelector('.active')?.scrollIntoView({block:'center'}));
  }
 }
 async function load(){
  try{
   if(!base)throw new Error('无法定位文件所属会话或工作目录');
   const data=await api(`${base}/file-preview?${query}`);if(generation!==filePreviewGeneration)return;
   state.data=data;
   const info=[filePreviewSize(data.size),data.modifiedAt?`修改于 ${filePreviewTime(data.modifiedAt)}`:''].filter(Boolean).join(' · ');
   meta.textContent=info||'当前内容';
   body.replaceChildren();
   if(data.mode==='text')render();
   else if(['image','pdf','audio','video'].includes(data.mode)){
    const url=`${base}/file-content?${query}`;
    // 视频默认走 720p30 轻量预览（服务端按需转码并缓存）；原片仍可通过不带 size 的地址取。
    const mediaUrl=data.mode==='video'?`${url}&size=preview`:url;
    const node=data.mode==='image'?h('img',{src:url,alt:data.name}):data.mode==='pdf'?h('iframe',{src:url,title:data.name,class:'file-preview-pdf'}):data.mode==='video'?h('video',{src:mediaUrl,controls:true,preload:'none',playsinline:''}):h(data.mode,{src:url,controls:true,preload:'metadata'});
    mediaNode=node;
    node.addEventListener('error',()=>body.replaceChildren(h('p',{role:'alert',class:'file-preview-empty'},'浏览器不支持此格式预览')));body.append(h('div',{class:'file-preview-media'},node));
   }else body.append(h('div',{class:'file-preview-empty'},h('p',{},'暂不支持此格式预览'),h('p',{class:'muted'},`${data.name} · ${data.type} · ${filePreviewSize(data.size)}`)));
  }catch(e){if(generation!==filePreviewGeneration)return;body.replaceChildren(h('div',{class:'file-preview-empty'},h('p',{role:'alert',class:'field-error'},e.message),h('button',{type:'button',class:'btn small',onclick:()=>{body.replaceChildren(h('p',{role:'status',class:'muted'},'正在读取…'));void load();}},'重试')));}
 }
 await load();
}
