"use strict";
/*
 * 通用图片放大查看：滚轮 / 双指自由放大缩小、拖动平移、双击切换适应/放大；
 * 多张时左右滑动或 ‹ › / ←→ 切换（当前图加载完后预加载并解码左右各 PRELOAD_SPAN 张，滑过去即显示）；未放大时下拉关闭；Esc 或点背景关闭。
 *
 * 用法：
 *   openImageZoom("https://…/a.png", "a.png")
 *   openImageZoom([{ src, name }, …], 2)   // 从第 3 张开始，可左右切换
 *   openImageZoom([{ src, name, original }])  // src 是压缩图，栏上多一个「原图」按钮切到 original
 *
 * 带 original 的条目：压缩图用 fetch 取（读响应头 X-Image-Compressed / X-Image-Original-Bytes），
 * 文件名旁标「已压缩 · WEBP 94 KB · 原图 1.2 MB」——文件名仍是原名（.png），单看名字分不出压没压缩。
 * img 的 data-source 记着当前显示的地址（压缩图经 blob: 显示）。
 *
 * 只做图片展示，不读取业务数据；动态变换一律走 CSSOM（el.style.xxx），不拼内联 style，避免被 CSP 拦。
 */
(function () {
  let active = null;
  /** 左右各预加载几张；更远的释放掉（blob: 和解码缓存），长图集也不会越翻越占内存 */
  const PRELOAD_SPAN = 3;
  const PRELOAD_PARALLEL = 3;

  function close(reason = "close") {
    if (!active) return;
    const a = active;
    active = null;
    document.removeEventListener("keydown", a.onKey, true);
    if (a.onHashChange) window.removeEventListener("hashchange", a.onHashChange);
    a.resizeObserver.disconnect();
    a.overlay.remove();
    document.body.classList.remove("image-zoom-open");
    for (const it of a.items || []) if (it.blobUrl) URL.revokeObjectURL(it.blobUrl);
    a.onClose?.(reason);
  }

  function normalize(a, b) {
    if (Array.isArray(a)) {
      const items = a
        .filter(Boolean)
        .map((it) => (typeof it === "string" ? { src: it, name: "" } : { ...it, src: it.src, name: it.name || "", original: it.original || "" }))
        .filter((it) => it.src);
      const index = Number.isInteger(b) ? Math.min(Math.max(0, b), Math.max(0, items.length - 1)) : 0;
      return { items, index };
    }
    return { items: [{ src: a, name: typeof b === "string" ? b : "" }], index: 0 };
  }

  function openImageZoom(a, b, options = {}) {
    let { items, index } = normalize(a, b);
    if (!items.length) return;
    close();

    let current = index, entry = index;
    let loadToken = 0;
    const state = { scale: 1, tx: 0, ty: 0, max: 8 };

    const overlay = document.createElement("div");
    overlay.className = "image-zoom";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", items.length > 1 ? "查看图片" : `查看图片 ${items[index].name}`);

    const title = document.createElement("span");
    title.className = "image-zoom-name";
    const counter = document.createElement("span");
    counter.className = "image-zoom-counter";
    const level = document.createElement("span");
    level.className = "image-zoom-level";

    const mkButton = (label, text, onClick, extraClass) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = extraClass || "image-zoom-btn";
      btn.setAttribute("aria-label", label);
      btn.title = label;
      btn.textContent = text;
      btn.addEventListener("click", onClick);
      return btn;
    };

    const stage = document.createElement("div");
    stage.className = "image-zoom-stage";
    const img = document.createElement("img");
    img.className = "image-zoom-img";
    img.draggable = false;
    // 用户正在看的这一张优先于旁边预载的图和后台读取；慢链路上先把它拉下来。
    img.setAttribute("fetchpriority", "high");
    const neighbors = [-1, 1].map((side) => {
      const el = document.createElement("img");
      el.className = "image-zoom-neighbor";
      el.draggable = false;
      el.setAttribute("fetchpriority", "low");
      el.alt = "";
      el.setAttribute("aria-hidden", "true");
      // 滑到一半时旁边那张还没好：跟着它一起移动的「正在加载…」，而不是一块空白
      const note = document.createElement("p");
      note.className = "image-zoom-neighbor-loading";
      note.setAttribute("aria-hidden", "true");
      stage.append(el, note);
      return { el, note, side };
    });
    const placeNeighbors = () => {
      for (const { el, note, side } of neighbors) note.style.transform = el.style.transform = `translateX(${side * stride() + slideX}px)`;
    };
    stage.append(img);
    /* 换地址后浏览器会一直显示上一张，直到新图解码完——切到另一张时先藏起来（只显示「正在加载…」），
       加载完 / 失败再露出，免得把上一张当成这一张。同一张图的换源（blob:、原图）不藏。 */
    const markPending = (el) => el.classList.toggle("pending", !(el.complete && el.naturalWidth));
    for (const el of [img, ...neighbors.map(n => n.el)]) {
      for (const type of ["load", "error"]) el.addEventListener(type, () => el.classList.remove("pending"));
    }
    let slideX = 0, dismissY = 0, settling = false;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const stride = () => stage.clientWidth + 16;
    function paintGesture() {
      img.style.transform = `translate(${slideX}px, ${dismissY}px) scale(${Math.max(.75, 1 - dismissY / Math.max(1, stage.clientHeight) * .3)})`;
      placeNeighbors();
      if (!options.artifactMode) overlay.style.backgroundColor = `rgba(0,0,0,${.88 * (1 - Math.min(.8, dismissY / Math.max(1, stage.clientHeight)))})`;
    }
    /** 要走 fetch 取压缩图的条目，blob: 没好之前给 null——不让 <img> 再并行下一遍同一张 */
    const needsFetch = (item) => item.original && item.original !== item.src && !item.showingOriginal;
    const displayUrl = (item) => item.showingOriginal ? item.original
      : item.blobUrl || (needsFetch(item) && !item.fetchFailed ? null : item.src);
    function refreshNeighbors() {
      for (const { el, side } of neighbors) {
        const item = items[current + side];
        el.hidden = !item;
        if (!item) continue;
        const url = displayUrl(item);
        if (!url) { el.removeAttribute("src"); el.classList.add("pending"); }
        else if (el.getAttribute("src") !== url) { el.src = url; markPending(el); }
      }
    }
    function syncNeighbors() {
      refreshNeighbors();
      slideX = dismissY = 0;
      paintGesture();
    }
    function settle(x = 0, y = 0, done = () => {}) {
      if (settling) return;
      settling = true;
      const elements = [img, ...neighbors.flatMap(n => [n.el, n.note]), overlay];
      const before = elements.map(el => ({ transform: el.style.transform, backgroundColor: el.style.backgroundColor }));
      slideX = x; dismissY = y;
      paintGesture();
      const animations = elements.map((el, i) => el.animate([
        before[i], { transform: el.style.transform, backgroundColor: el.style.backgroundColor }
      ], { duration: reducedMotion ? 0 : 260, easing: "cubic-bezier(.22,.75,.25,1)" }));
      Promise.all(animations.map(a => a.finished.catch(() => {}))).then(() => {
        settling = false;
        if (active?.overlay !== overlay) return;
        done();
      });
    }

    const apply = () => {
      img.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
      level.textContent = `${Math.round(state.scale * 100)}%`;
    };
    const clampScale = (s) => Math.min(state.max, Math.max(1, s));
    /** 以 (cx,cy)（相对舞台中心）为锚点缩放，锚点下的像素保持不动 */
    const zoomTo = (next, cx, cy) => {
      if (settling) return;
      const target = clampScale(next);
      if (target === state.scale) return;
      const k = target / state.scale;
      state.tx = cx - k * (cx - state.tx);
      state.ty = cy - k * (cy - state.ty);
      state.scale = target;
      apply();
    };
    const reset = () => { state.scale = 1; state.tx = 0; state.ty = 0; apply(); };
    const centerOf = (x, y) => {
      const r = stage.getBoundingClientRect();
      return { cx: x - r.left - r.width / 2, cy: y - r.top - r.height / 2 };
    };

    const prevBtn = mkButton("上一张", "‹", () => go(-1), "image-zoom-nav prev");
    const badge = document.createElement("span");
    badge.className = "image-zoom-badge";
    badge.hidden = true;
    const fmtBytes = (n) => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
    /** 文件名旁的标记：压缩版显示格式与大小、原图大小；看原图时显示原图大小 */
    function renderBadge(item) {
      const info = item.info;
      if (!info) { badge.hidden = true; return; }
      badge.hidden = false;
      const compressed = info.compressed && !item.showingOriginal;
      badge.classList.toggle("compressed", compressed);
      badge.textContent = compressed
        ? `已压缩 · ${info.format} ${fmtBytes(info.bytes)}${info.originalBytes ? ` · 原图 ${fmtBytes(info.originalBytes)}` : ""}`
        : `原图${info.originalBytes ? ` · ${fmtBytes(info.originalBytes)}` : ""}`;
      badge.title = compressed ? "为加快加载显示的是压缩图，点「原图」看原始文件" : "显示的是原始文件";
    }
    /** 取压缩图：读出是否压缩与原图大小，转成 blob: 显示；同一张只取一次 */
    function fetchItem(item) {
      if (!item.original || item.original === item.src) return null;
      if (!item.pending) {
        item.pending = fetch(item.src, { credentials: "same-origin" }).then(async (r) => {
          if (!r.ok) {
            item.error = (await r.json().catch(() => null))?.error || "图片暂时无法读取，请稍后重试。";
            throw new Error(String(r.status));
          }
          const blob = await r.blob();
          item.info = {
            compressed: r.headers.get("x-image-compressed") === "1",
            bytes: blob.size,
            originalBytes: Number(r.headers.get("x-image-original-bytes")) || 0,
            format: ((blob.type || "").split("/")[1] || "").toUpperCase(),
          };
          if (active && active.items === items) item.blobUrl = URL.createObjectURL(blob);
          return item;
        });
        item.pending.then(() => { item.fetchFailed = false; }, () => { item.pending = null; item.fetchFailed = true; });
      }
      return item.pending;
    }
    /** source：请求的地址（压缩图 / 原图）；shown：实际给 img 的地址（压缩图是 blob:） */
    function setSource(source, shown = source) { img.dataset.source = source; img.src = shown; }
    /* 默认看压缩图（公网更快）；需要看清细节时切原图，缩放位置不变 */
    const originalBtn = mkButton("查看原图", "原图", () => {
      const item = items[current];
      if (!item.original || item.showingOriginal) return;
      item.showingOriginal = true;
      originalBtn.hidden = true;
      stage.classList.add("loading");
      img.dataset.source = item.original;
      img.src = item.original;
      renderBadge(item);
    });
    originalBtn.classList.add("image-zoom-original");
    const nextBtn = mkButton("下一张", "›", () => go(1), "image-zoom-nav next");

    /* 预加载：先下一张、再上一张、再往外，最多 PRELOAD_PARALLEL 路并行；
       每张取完后 decode() 并留住 Image 对象，切过去时 <img> 同步就是解码好的，不会闪「正在加载…」。 */
    let preloadQueue = [], preloadBusy = 0, preloadAfterMain = null, preloadTimer = 0;
    function warm(item) {
      return Promise.resolve(fetchItem(item)).catch(() => null).then(() => {
        const url = displayUrl(item);
        if (!url || item.warmUrl === url) return;
        const pre = new Image();
        pre.fetchPriority = "low";
        pre.src = url;
        return pre.decode().then(() => { item.warm = pre; item.warmUrl = url; }, () => {});
      });
    }
    function pumpPreload() {
      while (preloadBusy < PRELOAD_PARALLEL && preloadQueue.length) {
        const item = preloadQueue.shift();
        if (item.warming || (item.warmUrl && item.warmUrl === displayUrl(item))) continue;
        item.warming = true; preloadBusy++;
        warm(item).finally(() => {
          item.warming = false; preloadBusy--;
          if (active?.overlay !== overlay) return;
          refreshNeighbors();
          pumpPreload();
        });
      }
    }
    function preloadAround(i) {
      const order = [];
      for (let d = 1; d <= PRELOAD_SPAN; d++) order.push(i + d, i - d);
      preloadQueue = order.filter((j) => j >= 0 && j < items.length).map((j) => items[j]);
      // 远处的释放掉；回来时重新取
      items.forEach((item, j) => {
        if (Math.abs(j - i) <= PRELOAD_SPAN + 2 || item.warming) return;
        if (item.blobUrl) { URL.revokeObjectURL(item.blobUrl); item.blobUrl = ""; item.pending = null; }
        item.warm = null; item.warmUrl = "";
      });
      pumpPreload();
    }
    /** 当前这张优先占带宽：它加载完（或最多等 1 秒）再预加载两边 */
    function schedulePreload(i) {
      preloadQueue = [];
      clearTimeout(preloadTimer);
      if (items.length < 2) return;
      const run = () => { if (preloadAfterMain !== run || !overlay.isConnected) return; preloadAfterMain = null; clearTimeout(preloadTimer); preloadAround(i); };
      preloadAfterMain = run;
      if (img.complete && img.naturalWidth) run();
      else preloadTimer = setTimeout(run, 1000);
    }

    function show(i) {
      current = i;
      renderNavigation();
      const item = items[i];
      title.textContent = item.name || `第 ${i + 1} 张`;
      title.title = item.name || "";
      counter.textContent = items.length > 1 || options.artifactMode ? `${i + 1} / ${items.length}` : "";
      prevBtn.hidden = i === 0;
      nextBtn.hidden = i === items.length - 1;
      reset();
      syncNeighbors();
      stage.classList.remove("error");
      overlay.classList.remove("has-image-error");
      originalBtn.hidden = !item.original || item.original === item.src || item.showingOriginal || (item.info && !item.info.compressed);
      stage.classList.add("loading");
      img.hidden = false;
      img.alt = item.name || "图片";
      renderBadge(item);
      const switched = img.dataset.item !== String(i) || !img.getAttribute("src");
      img.dataset.item = String(i);
      mountCollect(item);
      const token = ++loadToken;
      const job = item.showingOriginal ? null : fetchItem(item);
      if (job) {
        if (item.blobUrl) { setSource(item.src, item.blobUrl); if (switched) markPending(img); }
        else {
          // 压缩图还在 fetch：等 blob:，不让 <img> 再并行下载一遍
          img.dataset.source = item.src;
          img.removeAttribute("src");
          img.classList.add("pending");
        }
        job.then(() => {
          if (token !== loadToken) return;
          renderBadge(item);
          // 服务端发回的就是原图（已经够小或不能压缩）：「原图」按钮没有意义
          if (!item.info.compressed) originalBtn.hidden = true;
          if (img.getAttribute("src") !== item.blobUrl) { setSource(item.src, item.blobUrl || item.src); markPending(img); }
        }, () => { if (token === loadToken) { setSource(item.src); markPending(img); } });
      } else {
        setSource(item.showingOriginal ? item.original : item.src);
        if (switched) markPending(img);
        if (img.complete && img.naturalWidth) stage.classList.remove("loading");
      }
      schedulePreload(i);
    }
    const footer = document.createElement("nav");
    footer.className = "image-zoom-footer";
    footer.setAttribute("aria-label", options.onLocate ? "会话图片导航" : "图片导航");
    /* 产物控件固定在右下角；切图时按当前这张重建（已加入状态由产物目录自己恢复）。 */
    const collectHost = document.createElement("div");
    collectHost.className = "image-zoom-collect-host";
    if (options.artifactMode) { overlay.classList.add("is-artifact-preview"); footer.prepend(collectHost); }
    else overlay.append(collectHost);
    /** 控件贴着页面右下角，但要落在图片导航栏上方；导航栏高度会随「定位 / 回到进入处」两行变化。 */
    function placeCollect() {
      const node = collectHost.firstElementChild;
      if (!node) return;
      if (!options.artifactMode) node.style.bottom = `${(footer.hidden ? 0 : footer.offsetHeight) + 12}px`;
    }
    function mountCollect(item) {
      collectHost.replaceChildren();
      if (!options.tagControl) return;
      const node = options.tagControl(item, { capture: () => window.piArtifactCollect?.captureImageElement?.(img) });
      if (!node) return;
      node.classList.add("is-overlay");
      collectHost.append(node);
      placeCollect();
    }
    const rail = document.createElement("div");
    rail.className = "image-zoom-rail";
    rail.tabIndex = 0;
    rail.setAttribute("role", "slider");
    rail.setAttribute("aria-label", "图片位置");
    rail.setAttribute("aria-valuemin", "1");
    const navigationStatus = document.createElement("span");
    navigationStatus.className = "image-zoom-index-status";
    navigationStatus.setAttribute("role", "status");
    const retry = mkButton("重新加载会话图片", "重试", () => void loadGallery());
    retry.hidden = true;
    const locate = mkButton(options.locateLabel || "定位这条消息", "", () => {
      const item = items[current]; close("locate");
      Promise.resolve(options.onLocate?.(item)).catch(() => {
        if (typeof announce === "function") announce("消息定位失败，请重试");
      });
    });
    const back = mkButton("回到进入处", "", () => {
      if (!settling) { show(entry); rail.focus({ preventScroll: true }); }
    });
    function actionIcon(button, path) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
      const shape = document.createElementNS(svg.namespaceURI, "path");
      shape.setAttribute("d", path); svg.append(shape); button.append(svg);
    }
    actionIcon(locate, "M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4M8 9h8M8 13h6");
    actionIcon(back, "M9 5 3 11l6 6M3 11h10a7 7 0 0 1 7 7v2");
    const actions = document.createElement("div");
    actions.className = "image-zoom-location-actions";
    actions.append(locate, back);
    actions.hidden = !options.onLocate;
    footer.append(rail, actions, navigationStatus, retry);
    if (options.artifactMode) {
      // 产物只有单行底部操作区；多图导航浮在画布内，来源定位收进顶部详情。
      actions.hidden = true;
      stage.append(rail, navigationStatus, retry);
    }
    let railSignature = "", railPointer = null;
    function renderNavigation() {
      footer.hidden = !options.onLocate && !options.tagControl && items.length < 2;
      if (options.artifactMode) rail.hidden = items.length < 2;
      rail.setAttribute("aria-valuemax", String(items.length));
      rail.setAttribute("aria-valuenow", String(current + 1));
      rail.setAttribute("aria-valuetext", `当前第 ${current + 1} 张，共 ${items.length} 张；从第 ${entry + 1} 张进入`);
      const away = current !== entry;
      locate.hidden = !away && !options.locateAlways;
      back.hidden = !away;
      const position = i => items.length === 1 ? 50 : i / (items.length - 1) * 100;
      locate.style.left = `${position(current)}%`;
      back.style.left = `${position(entry)}%`;
      // Nearby markers retain distinct touch targets by placing the entry action one row lower.
      actions.classList.toggle("nearby", away && Math.abs(position(current) - position(entry)) * rail.clientWidth / 100 < 44);
      const signature = items.map(it => it.id || it.src).join("\n");
      if (signature !== railSignature) {
        railSignature = signature; rail.replaceChildren();
        items.forEach((item, i) => {
          const dot = document.createElement("span");
          dot.className = "image-zoom-dot";
          dot.style.left = `${items.length === 1 ? 50 : i / (items.length - 1) * 100}%`;
          dot.title = `第 ${i + 1} 张：${item.name || "图片"}`;
          rail.append(dot);
        });
      }
      [...rail.children].forEach((dot, i) => {
        dot.classList.toggle("current", i === current);
        dot.classList.toggle("entry", i === entry);
      });
      placeCollect();
    }
    const scrub = x => {
      const r = rail.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width)));
      const i = Math.round(fraction * (items.length - 1));
      if (!settling && i !== current) show(i);
    };
    rail.addEventListener("pointerdown", ev => {
      if (ev.button !== 0) return;
      ev.preventDefault(); railPointer = ev.pointerId; rail.focus({ preventScroll: true });
      try { rail.setPointerCapture(ev.pointerId); } catch { /* Synthetic tests */ }
      scrub(ev.clientX);
    });
    rail.addEventListener("pointermove", ev => { if (railPointer === ev.pointerId) scrub(ev.clientX); });
    const releaseRail = ev => { if (railPointer === ev.pointerId) railPointer = null; };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) rail.addEventListener(type, releaseRail);
    rail.addEventListener("keydown", ev => {
      if (ev.key !== "Home" && ev.key !== "End") return;
      ev.preventDefault(); if (!settling) show(ev.key === "Home" ? 0 : items.length - 1);
    });
    let indexLoading = false;
    async function loadGallery() {
      if (!options.loadItems || indexLoading) return;
      indexLoading = true; retry.hidden = true;
      navigationStatus.textContent = "正在收集会话图片…";
      try {
        const result = await options.loadItems();
        while (active?.overlay === overlay && (settling || pointers.size || railPointer !== null)) await new Promise(requestAnimationFrame);
        if (active?.overlay !== overlay) return;
        if (!result?.items?.length) throw new Error("图片目录为空");
        // The initial image keeps its decoded source, zoom, and pending original-image request.
        const fresh = normalize(result.items, result.index);
        const initial = items[current], saved = { ...state };
        Object.assign(initial, fresh.items[fresh.index]);
        fresh.items[fresh.index] = initial;
        items = fresh.items; entry = fresh.index; active.items = items;
        show(entry); Object.assign(state, saved); apply();
        navigationStatus.textContent = "";
      } catch {
        if (active?.overlay !== overlay) return;
        navigationStatus.textContent = "会话图片目录加载失败"; retry.hidden = false;
      } finally { indexLoading = false; }
    }

    function go(delta) {
      if (settling) return;
      const next = current + delta;
      if (next < 0 || next >= items.length) return;
      show(next);
    }

    /* 滚轮缩放（鼠标）/ 触控板 */
    stage.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const { cx, cy } = centerOf(ev.clientX, ev.clientY);
      zoomTo(state.scale * Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.06 : 0.0016)), cx, cy);
    }, { passive: false });

    /* 单指锁定方向：适应窗口时切图/下拉，放大时平移；取消手势始终回位。 */
    const pointers = new Map();
    let drag = null, pinch = null, moved = false, downOnStage = false;
    const beginDrag = (x, y) => ({ x, y, tx: state.tx, ty: state.ty, axis: "", started: performance.now(), pinched: false });
    stage.addEventListener("pointerdown", (ev) => {
      if (ev.target.closest("button, input, [role='slider']")) { downOnStage = false; return; }
      if (settling || (ev.pointerType === "mouse" && ev.button !== 0)) return;
      try { stage.setPointerCapture(ev.pointerId); } catch { /* synthetic events */ }
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      downOnStage = ev.target === stage || ev.target === img;
      if (pointers.size === 1) {
        moved = false;
        drag = beginDrag(ev.clientX, ev.clientY);
        stage.classList.add("dragging");
      } else if (pointers.size === 2) {
        moved = true;
        slideX = dismissY = 0; paintGesture(); apply();
        drag = null;
        const [p, q] = [...pointers.values()];
        pinch = { dist: Math.hypot(p.x - q.x, p.y - q.y), mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 } };
      }
    });
    stage.addEventListener("pointermove", (ev) => {
      if (!pointers.has(ev.pointerId)) return;
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size >= 2 && pinch) {
        const [p, q] = [...pointers.values()];
        const dist = Math.hypot(p.x - q.x, p.y - q.y);
        const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        if (pinch.dist > 0 && dist > 0) {
          const { cx, cy } = centerOf(mid.x, mid.y);
          zoomTo(state.scale * dist / pinch.dist, cx, cy);
          state.tx += mid.x - pinch.mid.x;
          state.ty += mid.y - pinch.mid.y;
          apply();
        }
        pinch.dist = dist; pinch.mid = mid;
      } else if (drag) {
        const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        if (Math.hypot(dx, dy) > 6) moved = true;
        if (state.scale > 1.01 || drag.pinched) {
          state.tx = drag.tx + dx; state.ty = drag.ty + dy; apply();
          return;
        }
        if (!drag.axis && moved) drag.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
        if (drag.axis === "x") {
          const edge = (dx > 0 && current === 0) || (dx < 0 && current === items.length - 1);
          slideX = edge ? Math.sign(dx) * 80 * (1 - Math.exp(-Math.abs(dx) / 240)) : Math.max(-stride(), Math.min(stride(), dx));
        } else if (drag.axis === "y") dismissY = Math.max(0, dy);
        paintGesture();
      }
    });
    const endPointer = (ev) => {
      if (!pointers.has(ev.pointerId)) return;
      pointers.delete(ev.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) {
        stage.classList.remove("dragging");
        if (drag && state.scale <= 1.01 && !drag.pinched) {
          const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
          const elapsed = Math.max(1, performance.now() - drag.started);
          const cancelled = ev.type !== "pointerup";
          if (!cancelled && drag.axis === "y" && (dy > Math.min(160, stage.clientHeight * .22) || (dy > 45 && dy / elapsed > .65))) {
            settle(0, stage.clientHeight, close);
          } else if (!cancelled && drag.axis === "x" && (Math.abs(dx) > stage.clientWidth * .25 || (Math.abs(dx) > 35 && Math.abs(dx) / elapsed > .5))) {
            const delta = dx < 0 ? 1 : -1;
            if (items[current + delta]) settle(-delta * stride(), 0, () => show(current + delta));
            else settle();
          } else settle();
        }
        drag = null;
      } else if (pointers.size === 1) {
        const [p] = [...pointers.values()];
        drag = { ...beginDrag(p.x, p.y), pinched: true };
      }
    };
    stage.addEventListener("pointerup", endPointer);
    stage.addEventListener("pointercancel", endPointer);
    stage.addEventListener("lostpointercapture", endPointer);

    /* 双击切换适应 / 2×；单击空白处关闭（拖动过就不算点击） */
    stage.addEventListener("dblclick", (ev) => {
      if (ev.target.closest("button, input, [role='slider']")) return;
      if (state.scale > 1.01) return reset();
      const { cx, cy } = centerOf(ev.clientX, ev.clientY);
      zoomTo(2, cx, cy);
    });
    stage.addEventListener("click", (ev) => { if (downOnStage && ev.target === stage && !moved) close(); });

    const bar = document.createElement("div");
    bar.className = "image-zoom-bar";
    bar.append(
      title,
      badge,
      counter,
      mkButton("缩小", "−", () => zoomTo(state.scale / 1.5, 0, 0)),
      level,
      mkButton("放大", "+", () => zoomTo(state.scale * 1.5, 0, 0)),
      mkButton("适应窗口", "适应", reset),
      originalBtn,
      mkButton("关闭", "×", close, "image-zoom-close")
    );
    if (options.artifactMode) {
      const header = document.createElement("header");
      header.className = "image-zoom-header";
      const heading = document.createElement("div");
      heading.className = "image-zoom-heading";
      const caption = document.createElement("div");
      caption.className = "image-zoom-caption";
      caption.append("图片 · ", counter);
      heading.append(title, caption);
      const details = document.createElement("dialog");
      details.className = "image-zoom-details";
      details.setAttribute("aria-label", "图片详情");
      const detailsHead = document.createElement("header");
      detailsHead.className = "image-zoom-details-head";
      const detailsTitle = document.createElement("strong");
      detailsTitle.textContent = "图片详情";
      const closeDetails = () => details.close();
      detailsHead.append(detailsTitle, mkButton("关闭详情", "×", closeDetails, "image-zoom-close"));
      const description = document.createElement("dl");
      const openDetails = () => {
        description.replaceChildren();
        const item = items[current];
        const field = (label, value) => {
          if (!value) return;
          const dt = document.createElement("dt"), dd = document.createElement("dd");
          dt.textContent = label; dd.textContent = value; description.append(dt, dd);
        };
        field("名称", item.name || "图片");
        field("来源会话", item.artifactItem?.source?.sessionTitle);
        field("文件状态", stage.classList.contains("error") ? item.error || "图片暂时无法读取，请稍后重试。" : stage.classList.contains("loading") ? "正在加载…" : "可预览");
        field("图片尺寸", !stage.classList.contains("error") && img.naturalWidth ? `${img.naturalWidth} × ${img.naturalHeight}` : "");
        for (const button of bar.querySelectorAll("button")) button.disabled = stage.classList.contains("error") || stage.classList.contains("loading");
        details.showModal();
      };
      // 缩放按钮保留在详情内，画布仍支持双指、滚轮和双击。
      bar.querySelector(".image-zoom-close").remove();
      const detailsSource = mkButton("回到原会话", "回到原会话 ↗", () => locate.click());
      detailsSource.hidden = !options.onLocate;
      details.append(detailsHead, description, bar, detailsSource);
      details.addEventListener("click", (ev) => { if (ev.target === details) closeDetails(); });
      details.addEventListener("keydown", ev => ev.stopPropagation());
      const detailsButton = mkButton("查看图片详情", "详情", openDetails, "image-zoom-details-button");
      header.append(heading, detailsButton, mkButton("关闭", "×", close, "image-zoom-close"));
      overlay.append(header, stage, prevBtn, nextBtn, footer, details);
    } else overlay.append(bar, stage, prevBtn, nextBtn, footer);
    document.body.append(overlay);
    document.body.classList.add("image-zoom-open");

    img.addEventListener("load", () => { stage.classList.remove("loading"); preloadAfterMain?.(); });
    img.addEventListener("error", () => {
      preloadAfterMain?.();
      stage.classList.remove("loading");
      stage.classList.add("error");
      img.hidden = true;
      overlay.classList.add("has-image-error");
      if (options.artifactMode) {
        errorNote.replaceChildren();
        const icon = document.createElement("span");
        icon.className = "image-zoom-error-icon"; icon.setAttribute("aria-hidden", "true");
        actionIcon(icon, "M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3ZM3 17l5-5 4 4 3-3 6 6M4 20 20 4M8 7h.01");
        const heading = document.createElement("strong");
        const message = items[current]?.error || "图片暂时无法读取，请稍后重试。";
        heading.textContent = message.includes("已失效") ? "图片已失效" : "图片暂不可用";
        const copy = document.createElement("p");
        copy.textContent = message;
        errorNote.append(icon, heading, copy);
        if (options.onLocate) errorNote.append(mkButton("回到原会话", "回到原会话 ↗", () => locate.click(), "image-zoom-recover"));
      }
    });

    const onKey = (ev) => {
      // 详情或标签弹层优先处理键盘；承载图片查看器的外层弹层不拦截。
      if ([...document.querySelectorAll("dialog[open]")].some(dialog => !dialog.contains(overlay))) return;
      if (ev.key === "Escape") { ev.preventDefault(); close(); return; }
      if (ev.key === "ArrowLeft") { ev.preventDefault(); go(-1); return; }
      if (ev.key === "ArrowRight") { ev.preventDefault(); go(1); return; }
      if (ev.key === "+" || ev.key === "=") { ev.preventDefault(); zoomTo(state.scale * 1.25, 0, 0); }
      if (ev.key === "-" || ev.key === "_") { ev.preventDefault(); zoomTo(state.scale / 1.25, 0, 0); }
      if (ev.key === "0") { ev.preventDefault(); reset(); }
    };
    document.addEventListener("keydown", onKey, true);

    show(index);
    // 加载失败时给一句可读提示
    const errorNote = document.createElement(options.artifactMode ? "div" : "p");
    errorNote.className = "image-zoom-error";
    errorNote.textContent = "图片加载失败或无权读取";
    stage.append(errorNote);
    const loadingNote = document.createElement("p");
    loadingNote.className = "image-zoom-loading";
    loadingNote.setAttribute("role", "status");
    loadingNote.textContent = "正在加载…";
    stage.append(loadingNote);

    const resizeObserver = new ResizeObserver(() => {
      renderNavigation();
      if (!settling) placeNeighbors();
    });
    resizeObserver.observe(stage);
    const onHashChange = options.closeOnNavigate ? () => close("navigation") : null;
    if (onHashChange) window.addEventListener("hashchange", onHashChange);
    active = { overlay, onKey, items, resizeObserver, onClose: options.onClose, onHashChange };
    void loadGallery();
    overlay.querySelector(".image-zoom-close")?.focus();
  }

  window.openImageZoom = openImageZoom;
})();
