"use strict";
/*
 * 产物 · 我的内容：把会话里看到的图片、视频、md / html 文档打标签收进「产物」。
 *
 * 分类就是标签：一个条目可以打多个分类；分类分一级 / 二级两层，可新建、改名、删除、合并、拖动排序
 * （整理面板见 artifact-category-browser.js，和待办页的分类面板同一套交互）。
 * 条目只记来源（会话 id + 消息 key / seq + 附件 id / 文件路径），不复制字节；
 * 原会话被删除时条目仍保留，打开 / 回到会话时给出「原会话已删除」的提示。
 *
 * 本文件只提供半屏交互和 URL 拼装；产物页、图片放大器、文件预览都调用这里的同一套入口。
 */
(function () {
  const STATE = { data: null, loading: null, error: "" };
  const CHANGE_EVENT = "pi-artifact-collections-change";

  const hh = (tag, attrs, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else if (k === "checked" || k === "disabled" || k === "selected") el[k] = Boolean(v);
      else el.setAttribute(k, String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c === undefined || c === null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  };

  function toast(text) {
    const fn = window.piToast || window.announce;
    if (typeof fn === "function") fn(text);
  }

  function emit() {
    try { window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: STATE.data })); } catch { /* 老浏览器 */ }
  }

  function apply(next) {
    if (next && Array.isArray(next.categories) && Array.isArray(next.items)) {
      STATE.data = next;
      emit();
    }
    return STATE.data;
  }

  async function load({ force = false } = {}) {
    if (!force && STATE.data) return STATE.data;
    if (STATE.loading) return STATE.loading;
    STATE.error = "";
    STATE.loading = (async () => {
      try {
        const data = await api("/api/artifact-collections");
        apply(data);
        return STATE.data;
      } catch (error) {
        STATE.error = error?.message || "产物分类读取失败";
        throw error;
      } finally {
        STATE.loading = null;
      }
    })();
    return STATE.loading;
  }

  const state = () => STATE.data || { schema: 1, categories: [], items: [] };
  const items = () => state().items || [];
  const categories = () => state().categories || [];
  const categoryById = (id) => categories().find((c) => c.id === id) || null;
  const categoryName = (id) => categoryById(id)?.name || "";
  const primaries = () => categories().filter((c) => !c.parentId);
  const childrenOf = (id) => categories().filter((c) => c.parentId === id);
  /** 选一级 = 它自己加下面所有二级；选二级 = 只有它。产物页筛选、计数都用这一套口径。 */
  const scopeIds = (id) => { const c = categoryById(id); return !c ? [] : c.parentId ? [c.id] : [c.id, ...childrenOf(c.id).map((k) => k.id)]; };
  const matchesCategory = (item, id) => { const ids = scopeIds(id); return (item.categoryIds || []).some((cid) => ids.includes(cid)); };
  /** 各行右侧的数字：一级 = 打了它或它任一二级的条目（不重复），二级 = 打了它的条目；all / uncategorized 为固定行。 */
  function counts() {
    const map = new Map([["all", items().length + (state().catalogRefsSeen || []).length], ["uncategorized", items().filter((item) => !(item.categoryIds || []).length).length]]);
    for (const category of categories()) map.set(category.id, items().filter((item) => matchesCategory(item, category.id)).length + categories().filter((c) => scopeIds(category.id).includes(c.id)).flatMap((c) => c.catalogRefs || []).length);
    return map;
  }
  const kindLabel = (kind) => kind === "document" ? "文档" : kind === "video" ? "视频" : "图片";

  function sourceKey(source) {
    if (!source || typeof source !== "object") return "";
    const s = source;
    if (s.type === "attachment") return JSON.stringify(["attachment", s.sessionId, s.attachmentId]);
    if (s.type === "generated") return JSON.stringify(["generated", s.sessionId, s.seq]);
    if (s.type === "file") return JSON.stringify(["file", s.sessionId, s.path]);
    return "";
  }

  function findBySource(source) {
    const key = sourceKey(source);
    return key ? items().find((item) => sourceKey(item.source) === key) || null : null;
  }

  function fileUrl(source, size) {
    if (!source || !source.sessionId) return "";
    const base = `/api/runtime-sessions/${encodeURIComponent(source.sessionId)}`;
    const sid = encodeURIComponent(source.sessionId);
    if (source.type === "attachment") {
      const q = new URLSearchParams({ session: source.sessionId });
      if (size) q.set("size", size);
      return `/api/runtime-attachments/${encodeURIComponent(source.attachmentId)}?${q}`;
    }
    if (source.type === "generated") {
      return `${base}/images/${encodeURIComponent(String(source.seq))}${size ? `?size=${encodeURIComponent(size)}` : ""}`;
    }
    const q = new URLSearchParams({ path: source.path });
    for (const hint of source.hints || []) q.append("hint", hint);
    if (size) q.set("size", size);
    // 显式带上会话，方便阅读日志时知道这条来自哪
    void sid;
    return `${base}/file-content?${q}`;
  }

  /** 预览地址：thumb 给卡片，view 给放大 / 播放器，空给原图。 */
  function sourceUrl(source, size) {
    return fileUrl(source, size);
  }

  function itemUrl(item, size) {
    if (item?.kind !== "image" || item.source?.type !== "file") return sourceUrl(item?.source, size);
    return `/api/artifact-collections/items/${encodeURIComponent(item.id)}/image${size ? `?size=${encodeURIComponent(size)}` : ""}`;
  }

  function sourceRef(source) {
    return source?.type === "file" ? { path: source.path, hints: source.hints } : null;
  }

  function sourceTitle(source) {
    if (!source) return "";
    return source.sessionTitle || "";
  }

  function eventTarget(source) {
    if (!source) return null;
    const key = source.eventKey || "";
    const seq = Number(source.eventSeq) || 0;
    return key || seq ? { key, seq } : null;
  }

  async function apiJson(path, options = {}) {
    const data = await api(path, options);
    if (data && Array.isArray(data.categories) && Array.isArray(data.items)) apply(data);
    return data;
  }

  const post = (path, body, method = "POST") => apiJson(path, { method, body: JSON.stringify(body || {}) });
  const catPath = (id) => `/api/artifact-collections/categories/${encodeURIComponent(id)}`;
  /** 分类目录的写入：每个都返回并应用最新的完整目录（含条目）。 */
  const categoryApi = {
    create: (name, parentId) => post("/api/artifact-collections/categories", { name, ...(parentId ? { parentId } : {}) }),
    rename: (id, name) => post(catPath(id), { name }, "PATCH"),
    remove: (id) => apiJson(catPath(id), { method: "DELETE" }),
    merge: (id, targetId) => post(`${catPath(id)}/merge`, { targetId }),
    reorder: (order, parents) => post("/api/artifact-collections/categories/order", { order, parents }, "PUT"),
  };

  /* ------------------------------ 半屏 ------------------------------ */

  function thumbNode(item) {
    if (item.kind === "document") return hh("span", { class: "artifact-collect-thumb is-doc", "aria-hidden": "true" }, "📄");
    if (item.kind === "video") return hh("span", { class: "artifact-collect-thumb is-video", "aria-hidden": "true" }, "▶");
    const url = sourceUrl(item.source, "thumb");
    const img = hh("img", { src: url, alt: "", loading: "lazy", decoding: "async" });
    const box = hh("span", { class: "artifact-collect-thumb" }, img);
    img.addEventListener("error", () => { box.replaceChildren(hh("span", { "aria-hidden": "true" }, "▣")); }, { once: true });
    return box;
  }

  /* ---------------------- 预览右下角：一键打标 + 标签状态 ---------------------- */

  /** 把当前显示的图片等比缩到模型上限内（不裁切），交给打标调用。 */
  async function captureImageElement(img, limit = 1600) {
    if (!img || !img.complete || !img.naturalWidth) throw new Error("图片还没加载完");
    const scale = Math.min(1, limit / img.naturalWidth, limit / img.naturalHeight);
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("图片无法读取");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return { mediaType: "image/jpeg", data: canvas.toDataURL("image/jpeg", 0.9).split(",")[1] || "" };
  }

  const tagLabel = (category) => category ? category.name : "";
  function itemTags(item) {
    return (item?.categoryIds || []).map((id) => {
      const category = categoryById(id);
      if (!category) return null;
      const parent = category.parentId ? categoryById(category.parentId) : null;
      return { category, label: tagLabel(category), path: parent ? `${parent.name} / ${category.name}` : category.name };
    }).filter(Boolean);
  }

  /**
   * 预览右下角的产物控件：
   * - 未加入：一个「＋ 加入产物」按钮；点击后交给 DeepSeek 打标并直接入库，不再弹半屏。
   * - 已加入：按钮变成「✓ 已加入」，上面是一排标签；点 ✓ 移出（可撤销），点标签打开和待办同款的两列目录改标签。
   * 控件由调用方放进图片放大器 / 文件预览，样式固定右下角。
   */
  function control(options = {}) {
    if (!options.source?.sessionId) return null;
    const source = options.source;
    const kind = options.kind || "image";
    const title = options.title || source.name || "";
    // 会话图片复用产物的单行标签交互，同时保留「已加入」状态按钮。
    const compact = options.compact || (kind === "image" && options.variant === "dark");
    const root = hh("div", {
      class: "artifact-collect-control" + (options.variant === "dark" ? " is-dark" : "") + (compact ? " is-compact" : ""),
      "data-source-kind": kind,
    });
    const tagsBox = hh("div", { class: "artifact-collect-tags", role: "group", "aria-label": "这条产物的标签", hidden: true });
    const undoBox = hh("p", { class: "artifact-collect-undo", role: "status", hidden: true });
    const actions = hh("div", { class: "artifact-collect-actions" });
    const main = hh("button", { type: "button", class: "artifact-collect-main" });
    const extras = (options.actions || []).filter((action) => action && typeof action.onClick === "function").map((action) => hh("button", {
      type: "button", class: "artifact-collect-extra", onclick: action.onClick,
    }, action.label));
    actions.append(...extras, main);
    const name = hh("strong", { class: "artifact-preview-name", hidden: true });
    const editButton = hh("button", { type: "button", class: "artifact-collect-extra", hidden: true, onclick: () => {
      if (item) edit(item, { onDone: (data, next) => { item = next || findBySource(source); draw(); options.onDone?.(data, item); } });
    } }, "名称与分类");
    actions.prepend(editButton);
    root.append(name, tagsBox, undoBox, actions);

    let item = STATE.data ? findBySource(source) : options.item || null;
    let busy = false;
    let errorText = "";
    let removed = null;
    let undoTimer = 0;

    const clearUndo = () => { clearTimeout(undoTimer); undoTimer = 0; removed = null; };

    const editTags = () => {
      if (!item || busy) return;
      openTagEditor(item, { onChange: (data, next) => { item = next; draw(); options.onDone?.(data, next); } });
    };
    const addTag = hh("button", { type: "button", class: "artifact-compact-add", "aria-label": "添加标签", title: "添加标签", onclick: editTags }, "＋");
    if (compact) root.insertBefore(addTag, actions);

    async function removeTag(id) {
      if (!item || busy) return;
      const snapshot = item;
      busy = true; draw();
      try {
        const data = await apiJson(`/api/artifact-collections/items/${encodeURIComponent(snapshot.id)}`, {
          method: "PATCH", body: JSON.stringify({ categoryIds: (snapshot.categoryIds || []).filter((cid) => cid !== id) }),
        });
        item = data.item || findBySource(source);
        options.onDone?.(data, item);
      } catch (error) { toast(error?.message || "标签移除失败，请重试"); }
      finally { busy = false; draw(); }
    }

    function draw() {
      name.hidden = !item; name.textContent = item?.title || ""; editButton.hidden = !item;
      const tags = item ? itemTags(item) : [];
      tagsBox.replaceChildren(...tags.map((tag) => hh("button", {
        type: "button", class: "artifact-collect-tag", title: `${tag.path} · 点击修改标签`,
        onclick: () => openTagEditor(item, { onChange: (data, next) => { item = next; draw(); options.onDone?.(data, next); } }),
      }, tag.label)));
      if (item && !tags.length) {
        tagsBox.append(hh("button", {
          type: "button", class: "artifact-collect-tag is-empty", title: "这条产物还没有标签，点击添加",
          onclick: () => openTagEditor(item, { onChange: (data, next) => { item = next; draw(); options.onDone?.(data, next); } }),
        }, "未分类"));
      }
      tagsBox.hidden = !item;

      if (compact) {
        name.hidden = editButton.hidden = true;
        tagsBox.replaceChildren();
        if (tags.length) {
          const tag = tags[0];
          tagsBox.append(hh("span", { class: "artifact-compact-tag" },
            hh("span", { title: tag.path }, tag.label),
            hh("button", { type: "button", disabled: busy, "aria-label": `删除标签 ${tag.label}`, onclick: () => void removeTag(tag.category.id) }, "×")));
          if (tags.length > 1) tagsBox.append(hh("button", { type: "button", class: "artifact-compact-more", disabled: busy,
            "aria-label": `查看全部 ${tags.length} 个标签`, onclick: editTags }, `+${tags.length - 1}`));
        } else tagsBox.append(hh("span", { class: "artifact-compact-empty" }, item ? "暂无标签" : removed ? "已移出产物" : "未加入产物"));
        tagsBox.hidden = false;
        addTag.hidden = !item;
        addTag.disabled = busy;
      }

      undoBox.hidden = compact || !removed;
      if (removed) undoBox.replaceChildren(document.createTextNode("已移出产物 "), hh("button", { type: "button", class: "artifact-collect-undo-btn", onclick: () => void undo() }, "撤销"));

      main.disabled = busy;
      main.className = "artifact-collect-main" + (item ? " is-added" : "") + (errorText ? " is-error" : "") + (busy ? " is-busy" : "");
      main.setAttribute("aria-label", item ? "已加入产物，点击移出" : busy ? "正在打标" : errorText ? "打标失败，点击重试" : "加入产物");
      main.title = item ? "已加入产物 · 点击移出" : errorText || "按内容自动打标，加入产物";
      if (busy) main.replaceChildren(hh("span", { class: "artifact-collect-spinner", "aria-hidden": "true" }), "打标中…");
      else if (item) main.replaceChildren(hh("span", { class: "artifact-collect-check", "aria-hidden": "true" }, "✓"), "已加入");
      else if (errorText) main.replaceChildren("打标失败 · 重试");
      else main.replaceChildren("＋ 加入产物");
      if (options.compact || (compact && removed)) {
        main.textContent = busy ? "处理中…" : item ? "移出产物" : removed ? "撤销移出" : "加入产物";
        main.setAttribute("aria-label", main.textContent);
      }
    }

    async function add() {
      if (busy) return;
      clearUndo();
      busy = true; errorText = ""; draw();
      try {
        let image = null;
        if (kind === "image" && typeof options.capture === "function") {
          try { image = await options.capture(); }
          catch { throw new Error("图片还没加载完，稍后再试"); }
        }
        const excerpt = typeof options.excerpt === "function" ? String(options.excerpt() || "") : "";
        const data = await apiJson("/api/artifact-collections/items/auto", {
          method: "POST",
          body: JSON.stringify({ title, source, ...(excerpt ? { excerpt } : {}), ...(image?.data ? { image } : {}) }),
        });
        item = data.item || null;
        const names = (data.tags || []).map((tag) => tag.secondary || tag.primary).filter(Boolean);
        toast(names.length ? `已加入产物：${names.join("、")}` : "已加入产物");
        options.onDone?.(data, item);
      } catch (error) {
        errorText = error?.message || "打标失败，请重试";
        toast(errorText);
      } finally { busy = false; draw(); }
    }

    async function remove() {
      if (busy || !item) return;
      busy = true; errorText = ""; draw();
      const snapshot = item;
      try {
        const data = await apiJson(`/api/artifact-collections/items/${encodeURIComponent(snapshot.id)}`, { method: "DELETE" });
        item = null;
        removed = snapshot;
        toast("已移出产物");
        options.onDone?.(data, null);
        clearTimeout(undoTimer);
        undoTimer = setTimeout(() => { removed = null; draw(); }, 6000);
      } catch (error) {
        errorText = error?.message || "移出失败";
        toast(errorText);
      } finally { busy = false; draw(); }
    }

    async function undo() {
      if (busy || !removed) return;
      busy = true; draw();
      const snapshot = removed;
      try {
        const data = await apiJson("/api/artifact-collections/items", {
          method: "POST",
          body: JSON.stringify({ title: snapshot.title, categoryIds: snapshot.categoryIds, source: snapshot.source }),
        });
        item = data.item || null;
        clearUndo();
        toast("已恢复产物");
        options.onDone?.(data, item);
      } catch (error) {
        errorText = error?.message || "撤销失败";
        toast(errorText);
      } finally { busy = false; draw(); }
    }

    main.addEventListener("click", () => { if (item) void remove(); else if (compact && removed) void undo(); else void add(); });
    draw();
    void load().then(() => {
      if (!removed) item = findBySource(source);
      draw();
    }).catch(() => { /* 读不到目录时仍可点加入，服务端会返回完整目录 */ });
    return root;
  }

  /** 消息里的 HTML 卡片没有右下角位置：用同一套智能打标直接加入，结果用轻提示回报。 */
  async function quickAdd(options = {}) {
    if (!options.source?.sessionId) return null;
    const existing = findBySource(options.source);
    if (existing) {
      const names = itemTags(existing).map((tag) => tag.label);
      toast(names.length ? `已在产物里：${names.join("、")}` : "已在产物里");
      return existing;
    }
    try {
      let image = null;
      if (options.kind === "image" && typeof options.capture === "function") {
        try { image = await options.capture(); } catch { /* 按标题打标 */ }
      }
      const data = await apiJson("/api/artifact-collections/items/auto", {
        method: "POST",
        body: JSON.stringify({ title: options.title || "", source: options.source, ...(options.excerpt ? { excerpt: options.excerpt } : {}), ...(image?.data ? { image } : {}) }),
      });
      const names = (data.tags || []).map((tag) => tag.secondary || tag.primary).filter(Boolean);
      toast(names.length ? `已加入产物：${names.join("、")}` : "已加入产物");
      options.onDone?.(data, data.item || null);
      return data.item || null;
    } catch (error) {
      toast(error?.message || "打标失败，请重试");
      return null;
    }
  }

  /** 修改标签：和待办编辑态同款——已选是 chips，＋添加分类展开左一级 / 右二级两列，可多选、可新建。 */
  function openTagEditor(target, options = {}) {
    if (!target) return null;
    const dialog = hh("dialog", { class: "artifact-tag-sheet", "aria-label": "修改标签" });
    const head = hh("header", { class: "artifact-tag-head" });
    const body = hh("div", { class: "artifact-tag-body" });
    const foot = hh("footer", { class: "artifact-tag-foot" });
    dialog.append(head, body, foot);
    const state = {
      item: target,
      selected: new Set((target.categoryIds || []).filter((id) => categoryById(id))),
      primaryId: null,
      picker: false,
      newName: "",
      error: "",
      notice: "",
      busy: false,
    };
    const selectedPath = (id) => {
      const c = categoryById(id);
      const p = c?.parentId ? categoryById(c.parentId) : null;
      return c ? (p ? `${p.name} / ${c.name}` : c.name) : "";
    };
    const syncPrimary = () => {
      if (state.primaryId && primaries().some((c) => c.id === state.primaryId)) return;
      const first = [...state.selected].map((id) => categoryById(id)).find(Boolean);
      const parent = first?.parentId ? categoryById(first.parentId) : first;
      state.primaryId = parent && !parent.parentId ? parent.id : primaries()[0]?.id || null;
    };
    const close = () => { try { dialog.close(); } catch { /* 已关闭 */ } dialog.remove(); };
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
    dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });

    function drawHead() {
      head.replaceChildren(
        hh("strong", {}, "修改标签"),
        hh("div", { class: "artifact-tag-head-actions" },
          hh("button", { type: "button", class: "btn small ghost", onclick: () => window.piArtifactCategoryBrowser?.openManager({ onChange: () => { for (const id of [...state.selected]) if (!categoryById(id)) state.selected.delete(id); draw(); } }) }, "管理分类"),
          hh("button", { type: "button", class: "btn small", onclick: close, "aria-label": "关闭" }, "关闭")),
      );
    }

    function chip(id) {
      return hh("span", { class: "artifact-tag-chip" },
        hh("span", { class: "artifact-tag-chip-label" }, selectedPath(id)),
        hh("button", {
          type: "button", class: "artifact-tag-chip-x", "aria-label": `移除标签：${selectedPath(id)}`, title: "移除",
          onclick: () => { if (state.busy) return; state.selected.delete(id); state.notice = ""; draw(); },
        }, "×"));
    }

    function toggle(category) {
      if (state.busy) return;
      state.notice = "";
      if (state.selected.has(category.id)) state.selected.delete(category.id);
      else if (state.selected.size >= 4) state.notice = "一条产物最多 4 个标签，先去掉一个再选";
      else state.selected.add(category.id);
      draw();
    }

    async function create() {
      const name = (state.newName || "").trim();
      if (!name || state.busy) return;
      if (!state.primaryId) { state.error = "先选一个一级分类"; draw(); return; }
      if (state.selected.size >= 4) { state.notice = "一条产物最多 4 个标签，先去掉一个再新建"; draw(); return; }
      state.busy = true; state.error = ""; draw();
      try {
        await categoryApi.create(name, state.primaryId);
        const created = categories().find((c) => c.parentId === state.primaryId && c.name === name);
        if (created) state.selected.add(created.id);
        state.newName = "";
        state.notice = created ? "" : "分类已建立，请再选一次";
      } catch (error) {
        state.error = error?.message || "新建失败";
      } finally { state.busy = false; draw(); }
    }

    async function save() {
      if (state.busy) return;
      state.busy = true; state.error = ""; draw();
      try {
        const data = await apiJson(`/api/artifact-collections/items/${encodeURIComponent(state.item.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ categoryIds: [...state.selected] }),
        });
        state.item = data.item || state.item;
        close();
        toast("标签已更新");
        options.onChange?.(data, state.item);
      } catch (error) {
        state.error = error?.message || "保存失败";
        draw();
      } finally { state.busy = false; }
    }

    function drawBody() {
      syncPrimary();
      const chosen = [...state.selected].filter((id) => categoryById(id));
      const tags = hh("div", { class: "artifact-tag-selected", role: "group", "aria-label": "这条产物的标签" },
        ...chosen.map(chip),
        !chosen.length ? hh("span", { class: "artifact-tag-empty" }, "还没有标签") : null,
        hh("button", { type: "button", class: "artifact-tag-add", "aria-expanded": String(state.picker), onclick: () => { state.picker = !state.picker; state.error = ""; draw(); } }, "＋ 添加分类"));

      let picker = null;
      if (state.picker) {
        const primary = primaries().find((c) => c.id === state.primaryId) || null;
        const children = primary ? childrenOf(primary.id) : [];
        const primaryColumn = hh("div", { class: "artifact-tag-column", "data-level": "primary", role: "group", "aria-label": "一级分类" },
          hh("p", { class: "artifact-tag-column-title" }, "一级分类"),
          primaries().length
            ? primaries().map((category) => hh("button", {
              type: "button", class: "artifact-tag-row" + (category.id === state.primaryId ? " active" : ""), "aria-pressed": String(category.id === state.primaryId),
              onclick: () => { state.primaryId = category.id; state.error = ""; state.notice = ""; draw(); },
            }, category.name))
            : hh("p", { class: "muted small" }, "还没有一级分类"));
        const secondaryColumn = hh("div", { class: "artifact-tag-column", "data-level": "secondary", role: "group", "aria-label": "二级分类" },
          hh("p", { class: "artifact-tag-column-title" }, primary ? `${primary.name} · 二级标签` : "二级标签"),
          children.length
            ? children.map((category) => {
              const on = state.selected.has(category.id);
              return hh("button", {
                type: "button", class: "artifact-tag-row" + (on ? " active" : ""), "aria-pressed": String(on), disabled: state.busy,
                onclick: () => toggle(category),
              }, hh("span", { class: "artifact-tag-check", "aria-hidden": "true" }, on ? "✓" : ""), category.name);
            })
            : hh("p", { class: "muted small" }, primary ? "还没有二级标签，在下面新建一个" : "先选一个一级分类"),
          primary ? hh("div", { class: "artifact-tag-create" },
            hh("input", {
              type: "text", maxlength: "30", value: state.newName, placeholder: "新建二级标签", "aria-label": "新建二级标签名称",
              oninput: (event) => { state.newName = event.currentTarget.value; },
              onkeydown: (event) => { if (event.key === "Enter") { event.preventDefault(); void create(); } },
            }),
            hh("button", { type: "button", class: "btn small", disabled: state.busy, onclick: () => void create() }, "新建")) : null);
        picker = hh("div", { class: "artifact-tag-picker" },
          hh("div", { class: "artifact-tag-columns" }, primaryColumn, secondaryColumn),
          state.notice ? hh("p", { class: "artifact-tag-notice", role: "status" }, state.notice) : null,
          state.error ? hh("p", { class: "field-error", role: "alert" }, state.error) : null);
      }
      body.replaceChildren(tags, ...(picker ? [picker] : []), hh("p", { class: "muted small artifact-tag-hint" }, "最多 4 个标签；和待办分类一样，左列一级、右列二级，可多选、可新建。"));
    }

    function drawFoot() {
      foot.replaceChildren(
        hh("button", { type: "button", class: "btn", disabled: state.busy, onclick: close }, "取消"),
        hh("button", { type: "button", class: "btn primary", disabled: state.busy, onclick: () => void save() }, state.busy ? "保存中…" : "保存"),
      );
    }

    function draw() { drawHead(); drawBody(); drawFoot(); }
    draw();
    document.body.append(dialog);
    dialog.showModal();
    void load().then(() => { if (dialog.isConnected) draw(); }).catch(() => { /* 先把已有的标签显示出来 */ });
    return { dialog, close };
  }

  function openSheet(options = {}) {
    document.querySelectorAll(".artifact-collect-sheet").forEach((el) => el.remove());
    const ctx = {
      source: options.source || options.item?.source || null,
      kind: options.kind || options.item?.kind || "image",
      title: options.title || options.item?.title || "",
      item: options.item || null,
      selected: new Set(options.item?.categoryIds || []),
      error: "",
      notice: "",
      busy: false,
      newName: "",
      newParent: "",
      onDone: options.onDone,
      onChange: options.onChange,
    };
    if (!ctx.item && ctx.source) ctx.item = findBySource(ctx.source);

    const dialog = hh("dialog", { class: "artifact-collect-sheet", "aria-label": "加入产物" });
    const head = hh("header", { class: "artifact-collect-head" });
    const body = hh("div", { class: "artifact-collect-body" });
    const foot = hh("footer", { class: "artifact-collect-foot" });
    dialog.append(head, body, foot);

    const close = () => { try { dialog.close(); } catch { /* 已关闭 */ } dialog.remove(); };
    dialog.addEventListener("cancel", (ev) => { ev.preventDefault(); close(); });
    dialog.addEventListener("click", (ev) => { if (ev.target === dialog) close(); });

    function setBusy(busy) { ctx.busy = busy; draw(); }

    async function mutate(run, message) {
      if (ctx.busy) return;
      ctx.error = ""; setBusy(true);
      try {
        const data = await run();
        apply(data);
        if (message) toast(message);
        ctx.onChange?.(STATE.data);
        return data;
      } catch (error) {
        ctx.error = error?.message || "保存失败";
        draw();
        return null;
      } finally { ctx.busy = false; draw(); }
    }

    function drawHead() {
      head.replaceChildren(
        hh("strong", {}, ctx.item ? "编辑产物" : "加入产物"),
        hh("button", { class: "btn small", type: "button", onclick: close, "aria-label": "关闭" }, "关闭"),
      );
    }

    function drawEdit() {
      const item = ctx.item;
      const source = ctx.source || item?.source;
      const presetTitle = ctx.title || item?.title || source?.name || "";
      const titleInput = hh("input", {
        type: "text", name: "artifact-title", value: presetTitle, maxlength: "120", autocomplete: "off",
        placeholder: "给这个产物起个名字", oninput: (ev) => { ctx.title = ev.currentTarget.value; },
      });
      /* 打过的分类被删 / 合并后不再存在：重画时顺手清掉，免得保存时带上无效标签 */
      for (const id of [...ctx.selected]) if (!categoryById(id)) ctx.selected.delete(id);
      const chip = (category, extra = "") => {
        const on = ctx.selected.has(category.id);
        return hh("button", {
          type: "button", class: "artifact-cat-chip" + extra, "aria-pressed": String(on),
          onclick: () => {
            if (ctx.busy) return;
            ctx.notice = "";
            if (on) ctx.selected.delete(category.id);
            else if (ctx.selected.size >= 4) ctx.notice = "一条产物最多 4 个标签，先取消一个再选";
            else ctx.selected.add(category.id);
            draw();
          },
        }, on ? "✓ " : "", category.name);
      };
      const groups = primaries().map((primary) => {
        const kids = childrenOf(primary.id);
        return hh("div", { class: "artifact-cat-group" },
          chip(primary, " is-primary"),
          kids.length ? hh("div", { class: "artifact-cat-subchips" }, kids.map((kid) => chip(kid, " is-secondary"))) : null);
      });
      if (!groups.length) groups.push(hh("span", { class: "muted small" }, "还没有分类，保存时会按类型自动建「" + (ctx.kind === "document" ? "文档" : ctx.kind === "video" ? "视频" : "图片") + "」。"));
      if (ctx.newParent && !categoryById(ctx.newParent)) ctx.newParent = "";
      const createRow = hh("div", { class: "artifact-cat-create" },
        hh("select", { class: "artifact-cat-parent", "aria-label": "新分类放在", onchange: (ev) => { ctx.newParent = ev.currentTarget.value; } },
          hh("option", { value: "", selected: !ctx.newParent }, "一级"),
          primaries().map((primary) => hh("option", { value: primary.id, selected: ctx.newParent === primary.id }, "「" + primary.name + "」下"))),
        hh("input", {
          type: "text", value: ctx.newName, maxlength: "30", placeholder: "新分类名称", "aria-label": "新分类名称",
          oninput: (ev) => { ctx.newName = ev.currentTarget.value; }, onkeydown: (ev) => { if (ev.key === "Enter") { ev.preventDefault(); void createCategory(); } },
        }),
        hh("button", { class: "btn small", type: "button", disabled: ctx.busy, onclick: () => void createCategory() }, "新建并选中"));
      const sourceLine = source
        ? (sourceTitle(source) ? "来自会话：" + sourceTitle(source) : "来自会话") + " · " + kindLabel(ctx.kind)
        : "点击按钮加入";
      body.replaceChildren(...[
        hh("div", { class: "artifact-collect-preview" },
          item ? thumbNode(item) : hh("span", { class: "artifact-collect-thumb is-doc", "aria-hidden": "true" }, ctx.kind === "document" ? "📄" : ctx.kind === "video" ? "▶" : "▣"),
          hh("div", { class: "artifact-collect-meta" },
            hh("strong", {}, presetTitle || kindLabel(ctx.kind)),
            hh("span", { class: "muted small" }, sourceLine))),
        hh("label", { class: "artifact-collect-field" }, hh("span", {}, "标题"), titleInput),
        hh("div", { class: "artifact-collect-field" },
          hh("div", { class: "artifact-collect-field-head" },
            hh("span", {}, "分类（可多选）"),
            hh("button", { class: "btn small ghost", type: "button", onclick: () => window.piArtifactCategoryBrowser?.openManager({ onChange: () => { if (dialog.isConnected) draw(); ctx.onChange?.(STATE.data); } }) }, "管理分类")),
          hh("div", { class: "artifact-cat-groups" }, groups),
          ctx.notice ? hh("p", { class: "artifact-tag-notice", role: "status" }, ctx.notice) : null,
          createRow),
        hh("p", { class: "muted small" }, "分类就是标签：可选一级或二级，一个产物可以同时放在多个分类里；不会复制或移动原文件。"),
        ctx.error ? hh("p", { class: "field-error", role: "alert" }, ctx.error) : null,
      ].filter(Boolean));
    }

    function drawFoot() {
      const editing = !!ctx.item;
      const buttons = [
        editing ? hh("button", { class: "btn small danger", type: "button", disabled: ctx.busy, onclick: () => void removeItem() }, "移出产物") : null,
        hh("span", { class: "artifact-collect-spacer" }),
        hh("button", { class: "btn", type: "button", disabled: ctx.busy, onclick: close }, "取消"),
        hh("button", { class: "btn primary", type: "button", disabled: ctx.busy, onclick: () => void save() }, ctx.busy ? "保存中…" : editing ? "保存" : "加入产物"),
      ].filter(Boolean);
      foot.replaceChildren(...buttons);
    }

    async function save() {
      if (ctx.busy) return;
      const title = (ctx.title || "").trim();
      if (!title) { ctx.error = "先给这个产物起个名字"; draw(); return; }
      const categoryIds = [...ctx.selected];
      if (ctx.item) {
        const data = await mutate(() => apiJson(`/api/artifact-collections/items/${encodeURIComponent(ctx.item.id)}`, {
          method: "PATCH", body: JSON.stringify({ title, categoryIds }),
        }), "产物已更新");
        if (data) { close(); ctx.onDone?.(STATE.data); }
      } else {
        const data = await mutate(() => apiJson("/api/artifact-collections/items", {
          method: "POST", body: JSON.stringify({ title, categoryIds, source: ctx.source }),
        }), "已加入产物");
        if (data) { close(); ctx.onDone?.(STATE.data); }
      }
    }

    async function removeItem() {
      if (!ctx.item || ctx.busy) return;
      if (!confirm(`把「${ctx.item.title}」移出产物？不会删除原文件。`)) return;
      const data = await mutate(() => apiJson(`/api/artifact-collections/items/${encodeURIComponent(ctx.item.id)}`, { method: "DELETE" }), "已移出产物");
      if (data) { close(); ctx.onDone?.(STATE.data); }
    }

    async function createCategory() {
      const name = (ctx.newName || "").trim();
      if (!name || ctx.busy) return;
      const parentId = ctx.newParent || undefined;
      const data = await mutate(() => categoryApi.create(name, parentId), "分类已建立");
      if (!data) return;
      const created = categories().find((c) => c.name === name && (c.parentId || undefined) === parentId);
      if (created) ctx.selected.add(created.id);
      ctx.newName = "";
      draw();
    }

    function draw() {
      drawHead();
      drawEdit(); drawFoot();
    }

    draw();
    document.body.append(dialog);
    dialog.showModal();
    void load().then(() => {
      if (dialog.isConnected) {
        // 第一次打开时按来源找到已存在的条目，直接进入编辑；分类数据也可能刚回来，重画一次
        if (!ctx.item && ctx.source) {
          ctx.item = findBySource(ctx.source);
          if (ctx.item) ctx.selected = new Set(ctx.item.categoryIds || []);
        }
        if (!ctx.item && !ctx.selected.size) {
          const preferred = ctx.kind === "document" ? "文档" : ctx.kind === "video" ? "视频" : "图片";
          const found = primaries().find((category) => category.name === preferred);
          if (found) ctx.selected.add(found.id);
        }
        draw();
      }
    }).catch(() => { /* 读取失败时保留空分类，保存时服务端会兜底 */ });

    return { dialog, close };
  }

  function open(options) {
    const existing = options?.item || (options?.source ? findBySource(options.source) : null);
    return openSheet({ ...options, item: existing });
  }

  function edit(item, options = {}) {
    if (!item) return null;
    return openSheet({ ...options, item, source: item.source, kind: item.kind, title: item.title });
  }

  /** 「分类管理」半屏：和产物页的分类面板同一套两列目录，直接进入编辑态。 */
  function manage(options = {}) {
    return window.piArtifactCategoryBrowser?.openManager(options) || null;
  }

  async function returnToSession(value) {
    const source = value?.source || value;
    if (!source?.sessionId) { toast("这条产物没有会话位置"); return false; }
    try {
      await api(`/api/runtime-sessions/${encodeURIComponent(source.sessionId)}?detail=summary`);
    } catch (error) {
      toast(error?.status === 404 ? "原会话已删除，产物仍然保留" : "会话暂时打不开，请稍后重试");
      return false;
    }
    if (typeof window.piRevealSessionEvent === "function") {
      try {
        const ok = await window.piRevealSessionEvent(source.sessionId, eventTarget(source) || {});
        if (!ok) toast("已打开会话，但没有找到那条消息");
        return !!ok;
      } catch { toast("已打开会话，但没有找到那条消息"); return false; }
    }
    location.hash = "#/rt/" + encodeURIComponent(source.sessionId);
    return true;
  }

  Object.assign(window, {
    piArtifactCollect: {
      CHANGE_EVENT,
      load, state, items, categories, categoryById, categoryName, kindLabel,
      primaries, childrenOf, scopeIds, matchesCategory, counts, categoryApi,
      sourceKey, findBySource, sourceUrl, sourceRef, sourceTitle, eventTarget,
      open, edit, manage, returnToSession, itemUrl,
      control, quickAdd, openTagEditor, captureImageElement,
      invalidate: () => { STATE.data = null; },
    },
  });
})();

/* ====================================================================
 * 以下是「产物分类目录面板」（原 artifact-category-browser.js）。并在同一个文件里发布：
 * 已安装的旧版 PWA 只接受 64 个以内的发布资源，多发一个脚本会让旧设备收不到更新。
 * ==================================================================== */
/*
 * 产物 · 分类目录面板：和「笔记·待办·日程」的分类面板同一套两列目录——左列一级、右列二级，
 * 每行带条目数，「编辑」进入整理（新增 / 改名 / 删除 / 合并 / 拖抓手调顺序，拖完点「保存」才写库）。
 * 样式直接沿用 notes 的 category-browser-*，两边外观和手感保持一致。
 *
 * 编辑态的状态放在模块里而不是元素里：产物页数据一变会整页重绘，面板重建后要还在原来的编辑进度上。
 * 数据与接口都来自 window.piArtifactCollect（artifact-collections.js）。
 */
(function () {
  const ID = "artifact-category-directory";
  const PENCIL = "✎";
  const STATE = {
    primaryId: null, editing: false, editingId: null, editDraft: "", error: "", notice: "", busy: false,
    merge: false, mergeIds: [], mergeTarget: "", adding: null, addDraft: "", draft: null, focus: null,
  };
  /** 当前面板的使用方：getFilter() 取选中项，onSelect(id, {keepOpen}) 通知产物页，onClose 给独立弹层用。 */
  let HOST = { getFilter: () => "", onSelect: null, onClose: null, title: "分类 · 我的产物" };

  const collect = () => window.piArtifactCollect;
  const tree = () => collect().categories();

  /* ---------- 编辑态的排序草稿：order = 期望的全局顺序，parents = 二级的期望父级 ---------- */
  function applyDraft(categories, draft) {
    if (!draft) return categories;
    const ids = new Set(categories.map((c) => c.id));
    const rank = new Map(draft.order.map((id, i) => [id, i]));
    return categories
      .map((c, i) => {
        const parentId = draft.parents[c.id];
        return { category: parentId && c.parentId && ids.has(parentId) ? { ...c, parentId } : c, key: rank.has(c.id) ? rank.get(c.id) : 1e9 + i };
      })
      .sort((a, b) => a.key - b.key)
      .map((entry) => entry.category);
  }
  function draftMove(view, sourceId, { parentId, beforeId }) {
    const list = view.map((c) => ({ ...c }));
    const from = list.findIndex((c) => c.id === sourceId);
    if (from < 0) return null;
    const [source] = list.splice(from, 1);
    if (parentId !== undefined) source.parentId = parentId;
    const at = beforeId ? list.findIndex((c) => c.id === beforeId) : -1;
    if (at >= 0) list.splice(at, 0, source); else list.push(source);
    return { order: list.map((c) => c.id), parents: Object.fromEntries(list.filter((c) => c.parentId).map((c) => [c.id, c.parentId])) };
  }
  /** 草稿和服务端顺序是否真的不同：同层级的相对顺序与父级都一样就算没变。 */
  function differs(stored, view) {
    const key = (list) => {
      const groups = new Map();
      for (const c of list) { const g = c.parentId || ""; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(c.id); }
      return JSON.stringify([...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    };
    return key(stored) !== key(view);
  }

  function counts() { return collect().counts(); }

  /* ---------- 一次写入：统一处理 busy / 报错 / 刷新面板 ---------- */
  function refresh() {
    const current = document.getElementById(ID);
    if (!current) return false;
    // 按住 / 拖动途中不能把面板换掉，否则手势的目标元素没了、拖动直接中断；放手后再补一次刷新。
    if (current.classList.contains("pressing") || current.classList.contains("dragging")) { STATE.stale = true; return true; }
    const scroll = {};
    current.querySelectorAll("[data-category-column]").forEach((el) => { scroll[el.getAttribute("data-category-column")] = el.scrollTop; });
    const next = directory();
    current.replaceWith(next);
    next.querySelectorAll("[data-category-column]").forEach((el) => { const top = scroll[el.getAttribute("data-category-column")]; if (top != null) el.scrollTop = top; });
    const focus = STATE.focus;
    if (focus) { STATE.focus = null; next.querySelector(`[data-category-focus="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true }); }
    return true;
  }
  function resetEditing() {
    Object.assign(STATE, { editingId: null, editDraft: "", merge: false, mergeIds: [], mergeTarget: "", adding: null, addDraft: "", error: "", notice: "" });
  }
  async function run(work, notice) {
    if (STATE.busy) return false;
    STATE.busy = true; STATE.error = ""; STATE.notice = "";
    refresh();
    let ok = false;
    try {
      await work();
      Object.assign(STATE, { editingId: null, editDraft: "", merge: false, mergeIds: [], mergeTarget: "", adding: null, addDraft: "" });
      STATE.notice = typeof notice === "function" ? notice() : notice || "";
      ok = true;
    } catch (error) {
      STATE.error = error?.message || "保存失败";
      // 失败后目录可能已被别的设备改过：重取一次，别让界面停在旧版本上。
      try { await collect().load({ force: true }); } catch { /* 保留原目录 */ }
    } finally {
      STATE.busy = false;
      refresh();
    }
    return ok;
  }

  function confirmDelete(category, categories, count) {
    const kids = category.parentId ? 0 : categories.filter((c) => c.parentId === category.id).length;
    const lines = [`删除分类「${category.name}」${kids ? `及其下 ${kids} 个二级分类` : ""}？`];
    lines.push(count ? `其中 ${count} 个产物会去掉这个标签（不会删除产物和原文件）。` : "这个分类下没有产物。");
    lines.push("此操作不可撤销。");
    if (!window.confirm(lines.join("\n"))) return;
    void run(() => collect().categoryApi.remove(category.id), "已删除。");
  }

  function mergeSelected(categories) {
    const picked = STATE.mergeIds.map((id) => categories.find((c) => c.id === id)).filter(Boolean);
    if (picked.length < 2) { STATE.error = "至少勾选 2 个同级分类"; refresh(); return; }
    const target = picked.find((c) => c.id === STATE.mergeTarget) || picked[0];
    const sources = picked.filter((c) => c.id !== target.id);
    const label = (c) => (c.parentId ? `${categories.find((x) => x.id === c.parentId)?.name || ""} / ${c.name}` : c.name);
    if (!window.confirm(`把 ${sources.map((c) => `「${label(c)}」`).join("、")} 合并到「${label(target)}」？\n这些分类下的产物会一起改打「${target.name}」，此操作不可撤销。`)) return;
    void run(async () => { for (const source of sources) await collect().categoryApi.merge(source.id, target.id); }, `已合并 ${picked.length} 个分类到「${target.name}」。`);
  }

  /** 新增：一级只要名字，二级挂在当前一级下；同级同名直接提示。 */
  function addCategory(level, parentId, name, categories) {
    const text = String(name || "").trim();
    if (!text) { STATE.error = "分类名称不能为空"; refresh(); return; }
    if (categories.some((c) => (level === "primary" ? !c.parentId : c.parentId === parentId) && c.name === text)) {
      STATE.error = `同级已有「${text}」`; refresh(); return;
    }
    void run(async () => {
      await collect().categoryApi.create(text, level === "primary" ? undefined : parentId);
      // 新增的一级直接选中，右列马上可以往里加二级。
      if (level === "primary") { const created = tree().find((c) => !c.parentId && c.name === text); if (created) STATE.primaryId = created.id; }
    }, `已新增「${text}」。`);
  }

  /** 构造面板。同一时刻页面上只会有一个（产物页的筛选面板或「分类管理」弹层）。 */
  function directory() {
    const state = STATE;
    const stored = tree();
    // 右列联动保留用户手动切换的一级；没有有效选择时才从筛选值回填。
    if (!stored.some((c) => c.id === state.primaryId && !c.parentId)) {
      const picked = stored.find((c) => c.id === HOST.getFilter());
      state.primaryId = picked ? picked.parentId || picked.id : stored.find((c) => !c.parentId)?.id || null;
    }
    if (state.editingId && !stored.some((c) => c.id === state.editingId)) { state.editingId = null; state.editDraft = ""; }
    state.mergeIds = state.mergeIds.filter((id) => stored.some((c) => c.id === id));
    if (state.mergeTarget && !state.mergeIds.includes(state.mergeTarget)) state.mergeTarget = "";
    if (state.adding?.level === "secondary" && !stored.some((c) => c.id === state.adding.parentId && !c.parentId)) state.adding = null;

    const categories = state.editing ? applyDraft(stored, state.draft) : stored;
    const dirty = state.editing && !!state.draft && differs(stored, categories);
    const tally = counts();
    const count = (id) => tally.get(id) || 0;
    const primaries = categories.filter((c) => !c.parentId);
    const selected = primaries.find((c) => c.id === state.primaryId) || null;
    const children = selected ? categories.filter((c) => c.parentId === selected.id) : [];
    const filter = HOST.getFilter();
    const rowCategory = new Map();
    let suppressClick = false;
    let press = null, drag = null, hover = null, ghost = null, scrollTimer = null, lastPoint = null;

    const root = h("div", {
      class: "notes-category-directory notes-category-browser artifact-category-directory", id: ID,
      role: "group", "aria-label": "产物分类",
      oncontextmenu: (e) => { if (drag) e.preventDefault(); },
    });

    const choose = (id, { keepOpen = false, primaryId } = {}) => {
      if (primaryId !== undefined) state.primaryId = primaryId;
      state.editingId = null; state.error = ""; state.notice = "";
      if (HOST.onSelect) HOST.onSelect(id, { keepOpen });
      else refresh();
    };
    const startEdit = (id) => {
      state.editingId = id; state.editDraft = categories.find((c) => c.id === id)?.name || state.editDraft; state.error = ""; state.notice = "";
      state.focus = `category-browser-${id}`;
      refresh();
    };

    /* ---------- 拖动排序（只在编辑态、只从抓手起手） ---------- */
    const clearHover = () => { if (hover?.row) hover.row.classList.remove("drop-before", "drop-after", "drop-inside"); hover = null; };
    const preventTouchScroll = (e) => { if (drag) e.preventDefault(); };
    const removeDocumentListeners = () => {
      document.removeEventListener("pointermove", onPointerMove, { passive: false });
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
      document.removeEventListener("touchmove", preventTouchScroll, { passive: false });
    };
    const settle = () => { if (STATE.stale) { STATE.stale = false; refresh(); } };
    const clearPress = () => { if (press?.timer) clearTimeout(press.timer); press = null; root.classList.remove("pressing"); removeDocumentListeners(); settle(); };
    const moveGhost = () => { if (ghost && lastPoint) ghost.style.transform = `translate3d(${lastPoint.x + 12 - Number(ghost.dataset.ox || 0)}px, ${lastPoint.y + 12 - Number(ghost.dataset.oy || 0)}px, 0)`; };
    const dragAutoScroll = () => {
      if (!drag || !lastPoint) return;
      const el = document.elementFromPoint(lastPoint.x, lastPoint.y);
      const scroller = el?.closest?.("[data-category-column]") || root;
      const rect = scroller.getBoundingClientRect();
      if (lastPoint.y < rect.top + 30) scroller.scrollTop -= 9;
      else if (lastPoint.y > rect.bottom - 30) scroller.scrollTop += 9;
    };
    const beginDrag = () => {
      if (!press) return;
      const { row, category, level } = press;
      drag = { row, category, level };
      press = null;
      root.classList.remove("pressing");
      row.classList.add("drag-source");
      root.classList.add("dragging");
      ghost = h("div", { class: "category-browser-ghost" }, category.name);
      // 管理面板是 <dialog>（浏览器顶层），挂在 body 上的幻影会被盖在弹层下面：幻影跟着面板走。
      (root.closest("dialog") || document.body).append(ghost);
      ghost.style.transform = "none";
      const origin = ghost.getBoundingClientRect();   // 弹层带 transform 时 fixed 的原点不在视口左上角：量出来再扣掉
      ghost.dataset.ox = String(origin.left); ghost.dataset.oy = String(origin.top);
      lastPoint = { x: row.getBoundingClientRect().left + 16, y: row.getBoundingClientRect().top + 16 };
      moveGhost();
      scrollTimer = setInterval(dragAutoScroll, 16);
    };
    const finishDrag = () => {
      clearHover();
      if (press?.timer) clearTimeout(press.timer);
      press = null; drag = null;
      removeDocumentListeners();
      if (scrollTimer) { clearInterval(scrollTimer); scrollTimer = null; }
      ghost?.remove(); ghost = null;
      root.classList.remove("dragging");
      root.querySelectorAll(".drag-source").forEach((el) => el.classList.remove("drag-source"));
      settle();
    };
    const placement = (row, source, target, level, y) => {
      const siblings = level === "primary" ? categories.filter((c) => !c.parentId) : categories.filter((c) => c.parentId === target.parentId);
      const others = siblings.filter((c) => c.id !== source.id);
      const index = others.findIndex((c) => c.id === target.id);
      const rect = row.getBoundingClientRect();
      const before = y < rect.top + rect.height / 2;
      return { before, beforeId: before ? target.id : (others[index + 1]?.id ?? null) };
    };
    const setHover = (row, target) => {
      const source = drag.category;
      if (!target || target.id === source.id) { clearHover(); return; }
      const sourcePrimary = !source.parentId, targetPrimary = !target.parentId;
      let next;
      if (sourcePrimary) {
        if (!targetPrimary) { clearHover(); return; }
        const place = placement(row, source, target, "primary", lastPoint.y);
        next = { row, target, source, kind: "reorder", beforeId: place.beforeId, before: place.before };
      } else if (targetPrimary) {
        if (target.id === source.parentId) next = { row, target, source, kind: "reorder", beforeId: null };
        else next = { row, target, source, kind: "move", parentId: target.id, beforeId: null };
      } else {
        const sameParent = target.parentId === source.parentId;
        const place = placement(row, source, target, "secondary", lastPoint.y);
        next = { row, target, source, kind: sameParent ? "reorder" : "move", beforeId: place.beforeId, ...(sameParent ? {} : { parentId: target.parentId }), before: place.before };
      }
      if (hover?.row !== row) { clearHover(); hover = next; }
      else { hover.kind = next.kind; hover.beforeId = next.beforeId; hover.before = next.before; hover.parentId = next.parentId; }
      row.classList.remove("drop-before", "drop-after", "drop-inside");
      if (hover.kind === "move") row.classList.add("drop-inside");
      else row.classList.add(hover.before === false ? "drop-after" : "drop-before");
    };
    function onPointerMove(ev) {
      if (press) {
        if (Math.abs(ev.clientX - press.startX) > 8 || Math.abs(ev.clientY - press.startY) > 8) {
          // 抓手不参与页面滚动（touch-action: none）：按住后一动就直接拖，不必等满长按时间。
          clearTimeout(press.timer);
          beginDrag();
        } else return;
      }
      if (!drag) return;
      ev.preventDefault();
      lastPoint = { x: ev.clientX, y: ev.clientY };
      moveGhost();
      const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.(".category-browser-row");
      if (!row || !root.contains(row)) { clearHover(); return; }
      setHover(row, rowCategory.get(row.getAttribute("data-category-row-id")));
    }
    function onPointerUp() {
      if (press) { clearPress(); return; }
      if (!drag) return;
      const action = hover ? { ...hover } : null;
      finishDrag();
      if (!action) return;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 400);
      // 拖动只改本地草稿，点「保存」才写库；草稿与服务端顺序一致时直接丢掉。
      const next = draftMove(categories, action.source.id, { ...(action.kind === "move" ? { parentId: action.parentId } : {}), beforeId: action.beforeId ?? null });
      if (!next) return;
      state.draft = differs(stored, applyDraft(stored, next)) ? next : null;
      state.error = ""; state.notice = "";
      refresh();
    }
    const startPress = (ev, row, category, level) => {
      if ((ev.button !== undefined && ev.button !== 0) || state.busy || !state.editing || state.merge) return;
      clearPress();
      press = { row, category, level, startX: ev.clientX, startY: ev.clientY };
      root.classList.add("pressing");
      press.timer = setTimeout(beginDrag, 180);
      document.addEventListener("pointermove", onPointerMove, { passive: false });
      document.addEventListener("pointerup", onPointerUp);
      document.addEventListener("pointercancel", onPointerUp);
      document.addEventListener("touchmove", preventTouchScroll, { passive: false });
    };

    /* ---------- 行 ---------- */
    const pinnedRow = (label, value, option = {}) => {
      const active = !!HOST.onSelect && filter === value;
      return h("div", { class: `category-browser-row pinned${active ? " active" : ""}` },
        h("button", {
          type: "button", class: "category-browser-name", "aria-pressed": String(active), "aria-label": `${label} ${count(option.countKey ?? value)}`,
          onclick: () => choose(value, option),
        }, h("span", { class: "category-browser-label" }, label)),
        h("span", { class: "category-browser-count" }, String(count(option.countKey ?? value))));
    };
    const toggleMerge = (category, level) => {
      const first = categories.find((c) => c.id === state.mergeIds[0]);
      if (first && (first.parentId ? "secondary" : "primary") !== level) state.mergeIds = [];
      state.mergeIds = state.mergeIds.includes(category.id) ? state.mergeIds.filter((id) => id !== category.id) : [...state.mergeIds, category.id];
      if (!state.mergeIds.includes(state.mergeTarget)) state.mergeTarget = "";
      state.error = "";
      refresh();
    };
    const rowFor = (category, level) => {
      rowCategory.set(category.id, category);
      if (state.editingId === category.id) {
        const input = h("input", {
          type: "text", value: state.editDraft, maxlength: "30", disabled: state.busy,
          "aria-label": level === "primary" ? "一级分类名称" : "二级分类名称",
          "data-category-focus": `category-browser-${category.id}`,
          oninput: (e) => { state.editDraft = e.target.value; },
          onkeydown: (e) => { if (e.key === "Escape") { e.preventDefault(); state.editingId = null; state.editDraft = ""; state.error = ""; refresh(); } },
        });
        return h("form", {
          class: "category-browser-edit",
          onsubmit: (e) => {
            e.preventDefault();
            const name = input.value.trim();
            if (!name) { state.error = "分类名称不能为空"; refresh(); return; }
            void run(() => collect().categoryApi.rename(category.id, name), "分类名称已更新。");
          },
        }, input,
          h("div", { class: "category-browser-edit-actions" },
            h("button", { type: "submit", class: "btn small primary", disabled: state.busy }, "保存"),
            h("button", { type: "button", class: "btn small", disabled: state.busy, onclick: () => { state.editingId = null; state.editDraft = ""; state.error = ""; refresh(); } }, "取消")));
      }
      const active = filter === category.id;
      const merging = state.editing && state.merge;
      const picked = merging && state.mergeIds.includes(category.id);
      const row = h("div", {
        class: `category-browser-row${active ? " active" : ""}${picked ? " merge-picked" : ""}${state.editing && level === "primary" && category.id === state.primaryId ? " shown" : ""}`,
        "data-category-row-id": category.id,
        "data-category-level": level,
        ...(merging ? { title: "勾选后一起合并" } : state.editing ? { title: level === "primary" ? "点击查看二级分类" : "点击名称修改" } : {}),
      },
        merging ? h("input", {
          type: "checkbox", class: "category-browser-check", checked: picked, disabled: state.busy,
          "aria-label": `选择 ${category.name}`,
          onclick: (ev) => ev.stopPropagation(),
          onchange: () => toggleMerge(category, level),
        }) : !state.editing ? null : h("span", {
          class: "category-browser-handle", "aria-hidden": "true", "data-category-handle": category.id, title: "按住拖动排序",
          onclick: (ev) => { ev.stopPropagation(); },
          onpointerdown: (ev) => { ev.stopPropagation(); startPress(ev, row, category, level); },
        }, "⋮⋮"),
        h("button", {
          type: "button", class: "category-browser-name",
          "aria-label": merging ? (level === "primary" ? `查看二级分类：${category.name}` : `合并选择：${category.name}`)
            : state.editing ? (level === "primary" ? `查看二级分类：${category.name}` : category.name)
            : `${category.name} ${count(category.id)}`,
          "aria-pressed": String(active),
        }, h("span", { class: "category-browser-label" }, category.name)),
        state.editing && !merging ? h("button", {
          type: "button", class: "category-browser-pencil", disabled: state.busy,
          "aria-label": `编辑分类：${category.name}`, title: "改名",
          onclick: (ev) => { ev.stopPropagation(); startEdit(category.id); },
        }, PENCIL) : null,
        state.editing && !merging ? h("button", {
          type: "button", class: "category-browser-delete", disabled: state.busy,
          "aria-label": `删除分类：${category.name}`, title: "删除分类",
          onclick: (ev) => { ev.stopPropagation(); confirmDelete(category, stored, count(category.id)); },
        }, "🗑") : null,
        h("span", { class: "category-browser-count" }, String(count(category.id))));
      row.addEventListener("click", () => {
        if (suppressClick) { suppressClick = false; return; }
        if (merging) {
          if (level === "primary") { state.primaryId = category.id; refresh(); } else toggleMerge(category, level);
          return;
        }
        if (state.editing) {
          if (level === "primary") { state.primaryId = category.id; state.adding = null; state.error = ""; refresh(); } else startEdit(category.id);
          return;
        }
        // 一级本身就是一个完整的筛选范围；点二级再收窄到具体二级。
        if (level === "primary") choose(category.id, { keepOpen: true, primaryId: category.id });
        else choose(category.id, { keepOpen: false, primaryId: category.parentId });
      });
      if (!state.editing) row.addEventListener("pointerdown", watchScrollGesture);
      return row;
    };
    // 常规浏览态没有拖动，但触屏滚动常从按钮上滑过：位移超过阈值就屏蔽随后的 click，避免误选分类。
    function watchScrollGesture(ev) {
      const startX = ev.clientX, startY = ev.clientY;
      let moved = false;
      const onMove = (e) => { if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) moved = true; };
      const onEnd = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onEnd);
        document.removeEventListener("pointercancel", onEnd);
        if (moved) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 400); }
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onEnd);
      document.addEventListener("pointercancel", onEnd);
    }

    /* ---------- 新增入口（列标题栏右侧） + 输入框（列表顶部） ---------- */
    const isAdding = (level, parentId) => !!state.adding && state.adding.level === level && state.adding.parentId === parentId;
    const closeAdd = () => { state.adding = null; state.addDraft = ""; state.error = ""; refresh(); };
    const addButton = (level, parentId) => {
      if (!state.editing || state.merge) return null;
      const label = level === "primary" ? "新增一级分类" : "新增二级分类";
      return h("button", {
        type: "button", class: `category-browser-edit-toggle category-browser-title-add${isAdding(level, parentId) ? " active" : ""}`,
        "aria-label": label, "aria-expanded": String(isAdding(level, parentId)), title: label, disabled: state.busy,
        onclick: () => {
          if (isAdding(level, parentId)) { closeAdd(); return; }
          state.adding = { level, parentId }; state.addDraft = ""; state.error = ""; state.notice = "";
          state.focus = "category-browser-add";
          refresh();
          document.querySelectorAll(`#${ID} [data-category-column]`).forEach((el) => { el.scrollTop = 0; });
        },
      }, "＋ 新增");
    };
    const addForm = (level, parentId) => {
      if (!state.editing || state.merge || !isAdding(level, parentId)) return null;
      const input = h("input", {
        type: "text", value: state.addDraft, maxlength: "30", disabled: state.busy,
        "aria-label": level === "primary" ? "新增一级分类名称" : "新增二级分类名称",
        "data-category-focus": "category-browser-add",
        oninput: (e) => { state.addDraft = e.target.value; },
        onkeydown: (e) => { if (e.key === "Escape") { e.preventDefault(); closeAdd(); } },
      });
      return h("form", {
        class: "category-browser-edit category-browser-add-form",
        onsubmit: (e) => { e.preventDefault(); addCategory(level, parentId, input.value, stored); },
      }, input,
        h("div", { class: "category-browser-edit-actions" },
          h("button", { type: "submit", class: "btn small primary", disabled: state.busy }, "添加"),
          h("button", { type: "button", class: "btn small", disabled: state.busy, onclick: closeAdd }, "取消")));
    };
    const columnTitle = (level, action) => h("h2", {
      class: `category-browser-column-title category-browser-column-title-${level}`,
      ...(level === "secondary" && selected ? { title: `${selected.name} 下的二级分类` } : {}),
    }, h("span", { class: "category-browser-column-title-text" }, level === "secondary" ? "二级分类" : "一级分类"), action || null);

    const mergeBar = () => {
      const picked = state.mergeIds.map((id) => categories.find((c) => c.id === id)).filter(Boolean);
      const label = (c) => (c.parentId ? `${categories.find((x) => x.id === c.parentId)?.name || ""} / ${c.name}` : c.name);
      const target = picked.find((c) => c.id === state.mergeTarget) || picked[0];
      const select = picked.length >= 2 ? h("select", {
        "aria-label": "合并后保留", onchange: (e) => { state.mergeTarget = e.target.value; },
      }, picked.map((c) => h("option", { value: c.id }, label(c)))) : null;
      if (select && target) select.value = target.id;
      return h("div", { class: "category-browser-merge-bar", role: "region", "aria-label": "合并操作" },
        h("span", { class: "muted small" }, picked.length < 2 ? `已选 ${picked.length} 个，至少勾选 2 个同级分类` : "已选 " + picked.length + " 个，合并后保留："),
        select,
        h("div", { class: "category-browser-edit-actions" },
          h("button", { type: "button", class: "btn small primary", disabled: state.busy || picked.length < 2, onclick: () => mergeSelected(stored) }, "合并"),
          h("button", { type: "button", class: "btn small", disabled: state.busy, onclick: () => { state.merge = false; state.mergeIds = []; state.mergeTarget = ""; state.error = ""; refresh(); } }, "取消")));
    };

    const leaveEditing = () => { resetEditing(); state.draft = null; state.editing = false; refresh(); };
    const uncategorized = count("uncategorized");
    root.append(...[
      h("header", { class: "category-browser-head" },
        h("div", { class: "category-browser-heading" },
          h("strong", {}, HOST.title),
          h("span", { class: "muted small" }, state.editing
            ? (state.merge ? "勾选要合并的同级分类，选好保留哪一个再提交"
              : dirty ? "顺序已调整：点「保存」生效，「取消」放弃"
              : "点一级看二级，✎ 改名，🗑 删除，拖抓手调顺序")
            : HOST.onSelect ? "点一级选整个分类，点二级筛选；点「编辑」整理分类" : "点「编辑」新增、改名、合并、拖动排序")),
        h("div", { class: "category-browser-head-actions" },
          state.editing ? h("button", {
            type: "button", class: `category-browser-edit-toggle${state.merge ? " active" : ""}`,
            "aria-pressed": String(state.merge), disabled: state.busy,
            onclick: () => { const on = !state.merge; resetEditing(); state.merge = on; refresh(); },
          }, "合并") : null,
          state.editing && dirty ? h("button", {
            type: "button", class: "category-browser-edit-toggle", disabled: state.busy, onclick: leaveEditing,
          }, "取消") : null,
          h("button", {
            type: "button", class: `category-browser-edit-toggle${state.editing ? " active" : ""}`,
            "aria-pressed": String(state.editing), disabled: state.busy,
            onclick: async () => {
              if (!state.editing) { resetEditing(); state.draft = null; state.editing = true; refresh(); return; }
              // 独立的管理面板只为整理而开：没改顺序时「完成」就是收起面板
              if (!dirty) { if (!HOST.onSelect && HOST.onClose) HOST.onClose(); else leaveEditing(); return; }
              // 保存排序：整份草稿一次提交；失败就留在编辑态显示原因，草稿作废、回到服务端顺序。
              const view = applyDraft(stored, state.draft);
              const ok = await run(() => collect().categoryApi.reorder(view.map((c) => c.id), Object.fromEntries(view.filter((c) => c.parentId).map((c) => [c.id, c.parentId]))), "排序已保存。");
              state.draft = null;
              if (ok) state.editing = false;
              refresh();
            },
          }, state.editing ? (dirty ? "保存" : "完成") : "编辑"))),
      state.error ? h("p", { class: "category-browser-feedback error", role: "alert" }, state.error) : null,
      state.notice ? h("p", { class: "category-browser-feedback success", role: "status" }, state.notice) : null,
      h("div", { class: "category-browser-columns" },
        h("section", { class: "category-browser-column", "data-category-column": "primary", "aria-label": "一级分类" },
          columnTitle("primary", addButton("primary", "")),
          addForm("primary", ""),
          pinnedRow("全部分类", "", { countKey: "all" }),
          uncategorized ? pinnedRow("未分类", "uncategorized") : null,
          ...primaries.map((c) => rowFor(c, "primary")),
          !primaries.length && !state.editing ? h("p", { class: "muted small category-browser-empty" }, "还没有分类：点「编辑」新增，或在加入产物时新建。") : null),
        h("section", { class: "category-browser-column", "data-category-column": "secondary", "aria-label": "二级分类" },
          columnTitle("secondary", selected ? addButton("secondary", selected.id) : null),
          selected ? addForm("secondary", selected.id) : null,
          selected ? pinnedRow("全部二级", selected.id, { keepOpen: true, primaryId: selected.id }) : null,
          ...children.map((c) => rowFor(c, "secondary")),
          selected && !children.length && !state.editing ? h("p", { class: "muted small category-browser-empty" }, "这个一级分类下还没有二级分类。") : null,
          !selected ? h("p", { class: "muted small category-browser-empty" }, "先选一个一级分类。") : null)),
      state.editing && state.merge ? mergeBar() : null,
    ].filter(Boolean));
    return root;
  }

  /** 产物页的筛选面板：host 提供选中项与选择回调。 */
  function create(host = {}) {
    HOST = { getFilter: () => "", onSelect: null, onClose: null, title: "分类 · 我的产物", ...host };
    return directory();
  }

  /** 每次打开面板（产物页展开 / 分类管理弹层）都从浏览态开始，不留上次的编辑进度。 */
  function reset({ editing = false } = {}) {
    resetEditing();
    Object.assign(STATE, { editing, draft: null, busy: false, primaryId: null, focus: null });
  }

  /** 独立的「分类管理」半屏：不选中任何分类，直接进入编辑态整理。 */
  function openManager({ onChange } = {}) {
    document.querySelectorAll(".artifact-category-manager").forEach((el) => el.remove());
    reset({ editing: true });
    const dialog = document.createElement("dialog");
    dialog.className = "artifact-collect-sheet artifact-category-manager";
    dialog.setAttribute("aria-label", "产物分类管理");
    const close = () => { try { dialog.close(); } catch { /* 已关闭 */ } dialog.remove(); onChange?.(); };
    dialog.addEventListener("cancel", (ev) => { ev.preventDefault(); close(); });
    dialog.addEventListener("click", (ev) => { if (ev.target === dialog) close(); });
    HOST = { getFilter: () => "", onSelect: null, onClose: close, title: "分类 · 我的产物" };
    dialog.append(directory());
    document.body.append(dialog);
    dialog.showModal();
    void collect().load().then(() => { if (dialog.isConnected) refresh(); }).catch(() => {});
    return { dialog, close };
  }

  window.piArtifactCategoryBrowser = { ID, create, reset, refresh, openManager };
})();
