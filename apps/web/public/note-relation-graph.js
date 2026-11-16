/* Deterministic graph layout. No simulation or external scripts. */
let relationGraphSerial = 0;
function noteRelationGraphRender(container, page, handlers) {
  const ns='http://www.w3.org/2000/svg',make=(tag,attrs,text)=>{const el=document.createElementNS(ns,tag);for(const[k,v]of Object.entries(attrs||{}))el.setAttribute(k,String(v));if(text!==undefined)el.textContent=text;return el;};
  const key=noteRelationKey,root=handlers.rootKey||key(page.nodes[0]?.ref||{kind:'note',noteId:''}),mobile=innerWidth<700,NW=mobile?148:176,HW=NW/2,LINE=mobile?9:11;
  const width=Math.max(280,Math.min(innerWidth-48,1060)),maxHeight=mobile?460:490,positions=new Map(),depth=new Map(),incoming=new Map(page.nodes.map(n=>[key(n.ref),0])),outgoing=new Map(),derivedNodes=new Set();
  for(const e of page.edges)if(e.type==='derived'&&incoming.has(key(e.from))&&incoming.has(key(e.to))){const a=key(e.from),b=key(e.to);incoming.set(b,incoming.get(b)+1);const list=outgoing.get(a)||[];list.push(b);outgoing.set(a,list);derivedNodes.add(a);derivedNodes.add(b);}
  const queue=[...incoming].filter(([,n])=>n===0).map(([k])=>k).sort();queue.forEach(k=>depth.set(k,0));
  for(let i=0;i<queue.length;i++){const k=queue[i];for(const b of outgoing.get(k)||[]){depth.set(b,Math.max(depth.get(b)||0,(depth.get(k)||0)+1));incoming.set(b,incoming.get(b)-1);if(incoming.get(b)===0)queue.push(b);}}
  const rootDepth=depth.get(root)||0;for(const n of page.nodes){const k=key(n.ref);depth.set(k,derivedNodes.has(k)?(depth.get(k)||0)-rootDepth:k===root?0:1);}
  const groups=new Map();for(const node of page.nodes){const d=depth.get(key(node.ref))??1,list=groups.get(d)||[];list.push(node);groups.set(d,list);}
  const levels=groups.size,widest=Math.max(1,...[...groups.values()].map(l=>l.length)),height=Math.max(260,Math.min(maxHeight,mobile?levels*125+40:widest*96+110));
  const min=Math.min(0,...groups.keys());for(const[d,list]of groups)list.forEach((node,i)=>positions.set(key(node.ref),mobile?{x:width/2+(i-(list.length-1)/2)*(NW+14),y:70+(d-min)*125}:{x:105+(d-min)*248,y:height/2+(i-(list.length-1)/2)*96}));
  const all=[...positions.values()],minX=Math.min(...all.map(p=>p.x-HW-4),0),maxX=Math.max(...all.map(p=>p.x+HW+4),width),minY=Math.min(...all.map(p=>p.y-40),0),maxY=Math.max(...all.map(p=>p.y+40),height);
  const fit=Math.min(1,(width-24)/(maxX-minX+24),(height-24)/(maxY-minY+24));
  const defaultView={scale:fit,x:width/2-(minX+maxX)/2*fit,y:height/2-(minY+maxY)/2*fit};
  const view=handlers.view||{};if(!Number.isFinite(view.scale))Object.assign(view,defaultView);
  const svg=make('svg',{viewBox:`0 0 ${width} ${height}`,role:'group','aria-label':'条目关系图谱'}),defs=make('defs'),marker=make('marker',{id:`relation-arrow-${++relationGraphSerial}`,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'});
  marker.append(make('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'currentColor'}));defs.append(marker);svg.append(defs);const group=make('g');svg.append(group);
  for(const edge of page.edges){const a=positions.get(key(edge.from)),b=positions.get(key(edge.to));if(!a||!b)continue;const start=mobile?{x:a.x,y:a.y+(b.y>=a.y?36:-36)}:{x:a.x+(b.x>=a.x?HW:-HW),y:a.y},end=mobile?{x:b.x,y:b.y+(b.y>=a.y?-36:36)}:{x:b.x+(b.x>=a.x?-HW:HW),y:b.y};
    const path=make('path',{d:mobile?`M${start.x},${start.y} C${start.x},${(start.y+end.y)/2} ${end.x},${(start.y+end.y)/2} ${end.x},${end.y}`:`M${start.x},${start.y} C${(start.x+end.x)/2},${start.y} ${(start.x+end.x)/2},${end.y} ${end.x},${end.y}`,class:'relation-edge'+(edge.type==='related'?' related':''),fill:'none',...(edge.type==='derived'?{'marker-end':`url(#${marker.id})`}:{'stroke-dasharray':'6 5'})});group.append(path);
  }
  let moved=false;
  page.nodes.forEach((node,i)=>{const k=key(node.ref),p=positions.get(k),title=node.state==='deleted'?'已删除条目':node.state==='unavailable'?'外部日程暂不可用':node.title||'无标题',g=make('g',{transform:`translate(${p.x-HW},${p.y-36})`,class:`relation-node${k===root?' center':''}${handlers.selectedKey===k?' selected':''}${node.state!=='available'?' unavailable':''}`,role:'button',tabindex:handlers.selectedKey===k||!handlers.selectedKey&&k===root?0:-1,'aria-label':`选择：${title}`,'data-relation-node':k});
    g.append(make('rect',{width:NW,height:72,rx:13}));const kind=node.displayKind==='note'?'笔记':node.displayKind==='todo'?'待办':'日程';g.append(make('text',{x:13,y:20,class:'relation-node-kind'},node.state==='available'?`${kind} · 关联 ${node.relationCount}`:title));
    {const first=title.slice(0,LINE),rest=title.slice(LINE),second=rest.length>LINE?rest.slice(0,LINE-1)+'…':rest;g.append(make('text',{x:13,y:42,class:'relation-node-title'},first));if(second)g.append(make('text',{x:13,y:59,class:'relation-node-title'},second));}g.append(make('title',{},title));
    g.addEventListener('click',()=>{if(!moved)handlers.select(node.ref);});g.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();handlers.select(node.ref);}else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(ev.key)){ev.preventDefault();const delta=ev.key==='ArrowLeft'||ev.key==='ArrowUp'?-1:1;svg.querySelectorAll('[data-relation-node]')[(i+delta+page.nodes.length)%page.nodes.length]?.focus();}});group.append(g);
  });
  const stage=h('div',{class:'relation-graph-stage',style:`height:${height}px`},svg),apply=()=>group.setAttribute('transform',`translate(${view.x},${view.y}) scale(${view.scale})`);apply();let drag=null;
  const down=e=>{if(e.button!==0)return;moved=false;drag={x:e.clientX,y:e.clientY,ox:view.x,oy:view.y};};
  const move=e=>{if(!drag)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>5)moved=true;if(moved){stage.setPointerCapture?.(e.pointerId);view.x=drag.ox+dx*width/Math.max(1,stage.clientWidth);view.y=drag.oy+dy*height/Math.max(1,stage.clientHeight);apply();}};
  const up=()=>{drag=null;};stage.addEventListener('pointerdown',down);stage.addEventListener('pointermove',move);stage.addEventListener('pointerup',up);stage.addEventListener('pointercancel',up);
  const zoom=f=>{const old=view.scale,next=Math.min(3,Math.max(.05,old*f));view.x=width/2-(width/2-view.x)*next/old;view.y=height/2-(height/2-view.y)*next/old;view.scale=next;apply();};
  const reset=()=>{Object.assign(view,defaultView);apply();};
  container.replaceChildren(h('div',{class:'relation-graph-controls'},h('button',{class:'btn small',type:'button','aria-label':'缩小图谱',onclick:()=>zoom(1/1.25)},'−'),h('button',{class:'btn small',type:'button','aria-label':'放大图谱',onclick:()=>zoom(1.25)},'＋'),h('button',{class:'btn small',type:'button',onclick:reset},'回到中心'),h('span',{class:'muted small'},'实线箭头：衍生 · 虚线：相关')),stage);
  return {resetView:reset,dispose(){stage.removeEventListener('pointerdown',down);stage.removeEventListener('pointermove',move);stage.removeEventListener('pointerup',up);stage.removeEventListener('pointercancel',up);}};
}
window.piRouteModules?.register('note-relation-graph',{});
