/* Screenshot entry points reuse the session and notes attachment flows. */
(() => {
  'use strict';
  const store = window.piImageIntakeStore;
  const RECOVERY = 'pi-agent:image-intake:recovery';
  let binding = null, lastBinding = null, queuedShares = [], generation = 0, detector, photoDetector, pending = null, startFlight, importing = false, hidden = false, notice = '';
  const clipboardDraftKeys = new Set();
  const active = new Map(), releases = new Map(), sessionUploads = new Set();
  let renewTimer, dismissTimer, dismissTick, dismissAt = 0, previewUrl;
  let linkPreview;
  const LINK_GLYPH = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a8a85" stroke-width="1.8" stroke-linecap="round"><path d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/></svg>');
  function linkIcon(item) {
    const img = document.createElement('img'); img.alt = ''; img.src = item.favicon || LINK_GLYPH;
    img.addEventListener('error', () => { if (img.src !== LINK_GLYPH) img.src = LINK_GLYPH; }); return img;
  }
  async function previewLink(item) {
    linkPreview?.abort(); const controller = new AbortController(); linkPreview = controller;
    try {
      const response = await fetch('/api/link-preview', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: item.url }), signal: controller.signal });
      if (!response.ok) return;
      const data = await response.json();
      if (pending !== item || controller.signal.aborted || item.expiresAt <= Date.now()) return;
      item.title = typeof data.title === 'string' && data.title.trim() ? data.title.slice(0, 240) : item.title;
      item.favicon = typeof data.favicon === 'string' && data.favicon.length < 100000 && /^data:image\/(?:png|jpeg|webp|svg\+xml|x-icon|vnd\.microsoft\.icon|gif);base64,[A-Za-z0-9+/=]+$/.test(data.favicon) ? data.favicon : '';
      window.piClipboardHistory?.update?.(item.url, { title: item.title, favicon: item.favicon });
      const panel = document.querySelector('.link-intake-prompt');
      const title = panel?.querySelector('.link-intake-title'), image = panel?.querySelector('.link-intake-mark img');
      if (title) title.textContent = item.title;
      if (image) image.src = item.favicon || LINK_GLYPH;
      window.dispatchEvent(new Event('pi-clipboard-pending-change'));
    } catch { /* Keep the domain label and link glyph. */ }
    finally { if (linkPreview === controller) linkPreview = null; }
  }
  function cancelDismiss() {
    clearTimeout(dismissTimer); clearInterval(dismissTick); dismissTimer = null; dismissTick = null; dismissAt = 0;
    document.querySelector('.image-intake-countdown')?.remove();
  }
  function updateCountdown() {
    const panel = document.getElementById('image-intake-prompt');
    if (!panel || !dismissAt) return;
    let label = panel.querySelector('.image-intake-countdown');
    if (!label) { label = document.createElement('p'); label.className = 'image-intake-countdown'; panel.append(label); }
    label.textContent = `${Math.max(1, Math.ceil((dismissAt - Date.now()) / 1000))} 秒后关闭`;
  }
  document.addEventListener('click', event => {
    if (!pending || hidden || importing || !document.getElementById('image-intake-prompt') || document.getElementById('image-intake-prompt')?.contains(event.target) || dismissTimer) return;
    const item = pending;
    dismissAt = Date.now() + 3000; updateCountdown();
    dismissTick = setInterval(updateCountdown, 1000);
    dismissTimer = setTimeout(() => { cancelDismiss(); if (pending === item && !importing) { hidden = true; paint(); } }, 3000);
  });
  const claimantKey = 'pi-agent:image-intake:claimant';
  let claimant;
  try { claimant = sessionStorage.getItem(claimantKey); if (!claimant) { claimant = store.randomId(); sessionStorage.setItem(claimantKey, claimant); } } catch { claimant = store.randomId(); }
  let channel;
  try { channel = new BroadcastChannel('pi-agent-image-intake'); channel.onmessage = e => { if (e.data?.type === 'invalidate' && e.data.binding === binding) void invalidate({ explicitLogout: e.data.explicitLogout, remote: true }); }; } catch {}
  const recovery = () => { try { return JSON.parse(sessionStorage.getItem(RECOVERY) || 'null'); } catch { return null; } };
  function remember() {
    try {
      // Auth loss must preserve locators for TTL cleanup, without displaying old bytes.
      if (!binding) return;
      const pendingIds = [...new Set([pending?.source === 'share' ? pending.shareId : null, ...queuedShares].filter(id => store.validId(id) && !active.has(id)))];
      if (!active.size && !pendingIds.length) { sessionStorage.removeItem(RECOVERY); return; }
      sessionStorage.setItem(RECOVERY, JSON.stringify({ ids: [...active.keys()], pendingIds, binding, text: typeof ui !== 'undefined' ? ui.notesDraft || '' : '' }));
    } catch { /* The blob is still in IndexedDB until TTL. */ }
  }
  function advance(item) {
    if (pending === item) {
      const next = queuedShares.shift();
      pending = next ? { source: 'share', intakeId: next, shareId: next } : null;
    }
    remember();
  }
  function sharedFile(row) { return new File([row.blob], '分享截图.' + ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[row.mime]), { type: row.mime }); }
  /** 相册图片的字节点下去才取（photos.image）：取不到就报错，不进上传状态机。 */
  async function intakeFile(item) {
    if (item.file) return item.file;
    if (typeof item.load !== 'function') throw new Error('图片已失效，请重新粘贴或上传');
    return await item.load();
  }
  /** 加号上的快捷气泡显示时不画卡片，报错只能走轻提示；成功类文案仍只走 announce。 */
  const bubbleShown = () => !!document.querySelector('.image-intake-bubble:not([hidden])');
  // 与手机浮动「＋」使用同一断点；检测可能早于气泡脚本 / 页面按钮就绪。
  const phoneLayout = window.matchMedia('(max-width: 760px)');
  function status(text, tone) { notice = text; if (typeof announce === 'function') announce(text); if (tone && bubbleShown()) window.piToast?.(text, { tone }); paint(); }
  function button(label, action) {
    const el = document.createElement('button'); el.type = 'button'; el.className = 'btn small'; el.textContent = label;
    el.disabled = importing; el.addEventListener('click', () => { void Promise.resolve().then(action).catch(error => status(error.message || '图片导入失败，请重试')); }); return el;
  }
  function paint() {
    window.dispatchEvent(new Event('pi-clipboard-pending-change'));
    document.getElementById('image-intake-prompt')?.remove();
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    document.getElementById('image-intake-status')?.remove();
    if (!pending || hidden || (pending.source === 'clipboard' && (phoneLayout.matches || pending.kind !== 'link' && document.querySelector('.rt-clipboard-shortcut') || bubbleShown() || pending.kind === 'link' && typeof ui !== 'undefined' && ui.view === 'web-x'))) return;
    const panel = document.createElement('aside'); panel.id = 'image-intake-prompt'; panel.className = 'image-intake-prompt'; panel.setAttribute('aria-label', '截图快捷创建');
    if (pending.kind === 'link') {
      panel.classList.add('link-intake-prompt'); panel.setAttribute('aria-label', '剪贴板链接');
      const label = document.createElement('p'); label.className = 'link-intake-label'; label.textContent = '发现剪贴板链接'; panel.append(label);
      const preview = document.createElement('a'); preview.className = 'link-intake-preview'; preview.href = pending.url; preview.target = '_blank'; preview.rel = 'noopener noreferrer';
      const mark = document.createElement('span'); mark.className = 'link-intake-mark'; mark.append(linkIcon(pending));
      const content = document.createElement('span'); content.className = 'link-intake-content';
      const title = document.createElement('strong'); title.className = 'link-intake-title'; title.textContent = pending.title;
      const host = document.createElement('span'); host.className = 'link-intake-host'; host.textContent = new URL(pending.url).hostname;
      content.append(title, host); preview.append(mark, content); panel.append(preview);
      if (notice) { const message = document.createElement('p'); message.textContent = notice; panel.append(message); }
      const actions = document.createElement('div'); actions.className = 'link-intake-actions';
      const todo = button('记录待办', () => act('notes')); todo.classList.add('primary');
      actions.append(todo, button('发起会话', () => act('session')), button('忽略', ignorePending)); panel.append(actions);
      document.body.append(panel); updateCountdown(); return;
    }
    const text = document.createElement('p'); text.setAttribute('role', 'status'); text.setAttribute('aria-live', 'polite');
    text.textContent = pending.append ? '已有未保存内容，是否追加图片？' : pending.source === 'share' ? '收到一张系统分享图片，确认后加入待办草稿' : pending.imageSource === 'album' ? '📷 发现新的相册图片' : '📷 发现新的剪贴板图片';
    panel.append(text);
    const previewSrc = pending.source === 'clipboard' ? (pending.thumb || (pending.file ? (previewUrl = URL.createObjectURL(pending.file)) : '')) : '';
    if (previewSrc) {
      const preview = document.createElement('img'); preview.className = 'image-intake-preview'; preview.alt = pending.imageSource === 'album' ? '相册图片预览' : '剪贴板截图预览';
      preview.src = previewSrc; panel.append(preview);
    }
    if (notice) { const message = document.createElement('p'); message.setAttribute('role', 'status'); message.textContent = notice; panel.append(message); }
    if (pending.source === 'clipboard' && !pending.append) panel.append(button('新建会话', () => importPending(true, 'session')));
    panel.append(button(pending.append ? '追加到当前草稿' : pending.source === 'share' ? '导入此次分享' : '创建待办', () => importPending(pending?.source === 'clipboard' || !!pending?.append)));
    panel.append(button(pending.append ? '稍后处理' : '忽略', ignorePending));
    document.body.append(panel);
    updateCountdown();
  }
  function ignorePending() {
    linkPreview?.abort(); linkPreview = null;
    if (pending?.append) { hidden = true; paint(); return; }
    (pending?.imageSource === 'album' ? photoDetector : detector)?.dismiss(pending?.intakeId);
    // An unclaimed share is owned only by this random URL, so claim before deleting it.
    const discarded = pending;
    // Ignoring a clipboard link also forgets that row in the AI browser history.
    if (discarded?.source === 'clipboard' && discarded.kind === 'link') window.piClipboardHistory?.removeUrl?.(discarded.url);
    advance(discarded); paint();
    if (discarded?.source === 'share') void discardShare(discarded.shareId);
  }
  /** 加号上的快捷气泡：session = 新建会话并上传，notes = 创建待办并上传，ignore = 忽略。只处理剪贴板 / 相册图片。 */
  async function act(action) {
    if (pending?.source !== 'clipboard' || importing) return false;
    if (action === 'ignore') { ignorePending(); return true; }
    if (pending.kind === 'link') {
      if (action === 'open') { await openLink(pending); return true; }
      if (action === 'session' || action === 'notes') { await importLink(action); return true; }
      return false;
    }
    if (action !== 'session' && action !== 'notes') return false;
    await importPending(true, action);
    return true;
  }
  async function openUrl(url) {
    if (!window.piAndroidShell?.available) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
    const result = await window.piAndroidShell.status();
    if (!result.capabilities?.includes('browser.link.open')) throw new Error('请升级 App 以使用内置链接浏览');
    await window.piAndroidShell.call('browser.link.open', { url });
  }
  async function openLink(item) {
    if (item.expiresAt <= Date.now()) throw new Error('链接提示已过期，请重新复制');
    await openUrl(item.url);
  }
  async function importLink(target) {
    const item = pending, epoch = generation;
    if (!item || importing || item.expiresAt <= Date.now()) return;
    importing = true; cancelDismiss(); paint();
    try {
      const owner = await authorize();
      if (epoch !== generation || owner !== binding) throw new Error('访问状态已变化，请重新导入');
      const module = target === 'session' ? 'rt-new' : 'notes';
      if (window.piRouteModules?.has(module)) await window.piRouteModules.ensure(module);
      if (epoch !== generation || pending !== item) return;
      const text = (item.title && item.title !== new URL(item.url).hostname ? item.title + '\n' : '') + item.url;
      if (target === 'session') {
        if (ui.rt?.busy || ui.rt?.launch || ui.rt?.confirm || rtImageDraft('new').pending) throw new Error('请先处理正在发起的会话');
        const form = rtForm(); form.prompt = form.prompt?.trim() ? form.prompt + '\n\n' + text : text;
        if (typeof rtMarkNewEntry === 'function') rtMarkNewEntry('image');
        rtSaveImageDraft('new', form.prompt); location.hash = '#/rt/new';
      } else {
        if (ui.notesBusy) throw new Error('待办正在保存，请稍后重试');
        ui.notesDraft = ui.notesDraft?.trim() ? ui.notesDraft + '\n\n' + text : text;
        ui.notesDraftKind = 'todo'; ui.notesDraftRevision = (ui.notesDraftRevision || 0) + 1;
        ui.notesComposerOpen = true; location.hash = '#/notes';
      }
      if (typeof route === 'function') route();
      if (target === 'notes') { if (typeof notePatchComposer === 'function') notePatchComposer(); noteOpenComposer(); }
      detector?.imported(item.intakeId); advance(item); hidden = false; notice = ''; linkPreview?.abort();
    } catch (error) { status(error.message || '链接导入失败，请重试', 'warn'); }
    finally { importing = false; paint(); }
  }
  async function authorize() {
    const response = await fetch('/api/image-intake/access', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('请先登录，再重新打开此次分享');
    const access = await response.json();
    if (typeof access.binding !== 'string' || !access.binding || access.binding.length > 200) throw new Error('访问状态无法确认，请重新登录');
    return access.binding;
  }
  async function lockShare(id) {
    if (!navigator.locks || releases.has(id)) return;
    await new Promise((resolve, reject) => {
      navigator.locks.request('pi-image-intake:' + id, { ifAvailable: true }, async lock => {
        if (!lock) { reject(new Error('此图片正在另一窗口编辑，请稍后重试')); return; }
        await new Promise(release => { releases.set(id, release); resolve(); });
      }).catch(reject);
    });
  }
  function releaseShare(id) { releases.get(id)?.(); releases.delete(id); }
  async function discardShare(id) {
    try {
      const ownerBinding = await authorize();
      await store.claim({ shareId: id, ownerBinding, claimant, confirmUnbound: true });
      await store.finish(id, claimant);
    } catch { status('图片暂未清理，将在过期后自动删除'); }
  }
  async function importPending(appendConfirmed = false, target = 'notes') {
    const item = pending, epoch = generation;
    cancelDismiss();
    if (!item || importing) return;
    if (item.expiresAt && item.expiresAt <= Date.now()) { pending = null; status('图片已失效，请重新粘贴或上传', 'warn'); return; }
    if (target === 'notes' && typeof ui !== 'undefined' && ui.notesBusy) { status('待办正在保存，请稍后再导入', 'warn'); return; }
    if (!appendConfirmed && typeof ui !== 'undefined' && (String(ui.notesDraft || '').trim() || ui.notesImages?.length)) { item.append = true; paint(); return; }
    importing = true; paint();
    try {
      const currentBinding = await authorize();
      if (epoch !== generation || (binding && binding !== currentBinding)) throw new Error('访问状态已变化，请重新导入');
      binding = currentBinding; lastBinding = binding;
      let file = item.file, row;
      if (item.source === 'share') {
        await lockShare(item.shareId);
        row = await store.claim({ shareId: item.shareId, ownerBinding: binding, claimant, confirmUnbound: true });
        file = sharedFile(row);
      }
      if (!file) file = await intakeFile(item);
      await store.validate(file);
      if (epoch !== generation) throw new Error('访问状态已变化，请重新导入');
      if (target === 'session') {
        if (window.piRouteModules?.has('rt-new')) await window.piRouteModules.ensure('rt-new');
        if (epoch !== generation) return;
        if (typeof rtAddImages !== 'function' || typeof rtImageDraft !== 'function') throw new Error('会话编辑器尚未就绪，请重试');
        if (rtImageDraft('new').images.length >= 5 || ui.rt?.busy || ui.rt?.launch?.req) throw new Error('会话附件已满或正在创建，请处理后重试');
        // 从图片导入 / 分享进入：不是会话列表的入口，提交后要问用户去哪
        if (typeof rtMarkNewEntry === 'function') rtMarkNewEntry('image');
        location.hash = '#/rt/new';
        if (typeof route === 'function') route();
        (item.imageSource === 'album' ? photoDetector : detector)?.imported(item.intakeId); advance(item); hidden = false; notice = ''; paint();
        const controller = new AbortController(); sessionUploads.add(controller);
        try { await rtAddImages('new', [file], { intakeId: item.intakeId, isCurrent: () => epoch === generation, signal: controller.signal, cancel: () => controller.abort() }); }
        finally { sessionUploads.delete(controller); }
        return;
      }
      if (window.piRouteModules?.has('notes')) await window.piRouteModules.ensure('notes');
      if (epoch !== generation) return;
      if (!appendConfirmed && (String(ui.notesDraft || '').trim() || ui.notesImages?.length)) { item.append = true; return; }
      location.hash = '#/notes';
      if (typeof route === 'function') route();
      if (typeof noteImportImage !== 'function') throw new Error('待办编辑器尚未就绪，请重试');
      if (typeof ui !== 'undefined' && ui.view !== 'notes') throw new Error('请先打开待办，再重试导入');
      if (!noteImportImage({ intakeId: item.intakeId, file, source: item.source })) throw new Error('草稿附件已满或正在保存，请处理后重试');
      if (item.source === 'share') { active.set(item.shareId, { expiresAt: row.expiresAt }); remember(); beginRenew(); }
      (item.imageSource === 'album' ? photoDetector : detector)?.imported(item.intakeId);
      advance(item); hidden = false;
      noteOpenComposer();
      {
        status('图片正在上传，可补充文字后保存');
        const uploaded = await noteUploadIntake(item.intakeId);
        if (epoch !== generation) return;
        remember();
        status(uploaded ? (row?.extraCount ? `已上传第 1 张图片，其余 ${row.extraCount} 张未导入` : '图片已上传，可补充文字后保存') : '图片上传失败，请点击记下重试，或从相册重新添加');
      }
    } catch (error) {
      if (item.source === 'share' && !active.has(item.shareId)) releaseShare(item.shareId);
      if (epoch === generation) status(error.message || '图片导入失败，请重试或从相册上传', 'warn');
    } finally { if (item.source === 'share' && !active.has(item.shareId)) releaseShare(item.shareId); importing = false; paint(); }
  }
  function beginRenew() {
    clearInterval(renewTimer);
    renewTimer = setInterval(() => {
      for (const [id, entry] of active) {
        if (entry.expiresAt <= Date.now()) { void invalidate({ remote: true }); status('分享草稿已过期，请重新分享'); return; }
        void store.renew(id, claimant).catch(() => { void invalidate({ remote: true }); status('分享草稿已失效，请重新分享'); });
      }
    }, 10000);
  }
  async function start() {
    if (startFlight) return startFlight;
    startFlight = (async () => {
      const epoch = generation;
      try {
        // 相册检测不等页面身份：气泡可以先出现在输入框旁，身份到齐后再补上游标与导入校验。
        photoDetector ||= window.piRecentPhotos?.create({ binding: binding || '', onImage: item => {
          if (epoch !== generation) return false;
          if (!item) { if (pending?.imageSource === 'album') { cancelDismiss(); pending = null; paint(); } return; }
          if (pending?.source === 'share') return false;
          cancelDismiss(); notice = ''; pending = { ...item, source: 'clipboard', imageSource: 'album' }; hidden = false; paint();
        }, onUnavailable: text => { window.piToast?.(text, { tone: 'warn' }); } });
        const owner = await authorize(); if (epoch !== generation) return;
        if (binding && binding !== owner) { await invalidate({ remote: true }); return; }
        binding = owner; lastBinding = owner;
        photoDetector?.bindOwner?.(binding);
        detector ||= window.piClipboardImages?.create({ binding, onImage: item => {
          if (epoch !== generation) return;
          if (!item) { if (pending?.source === 'clipboard' && pending.imageSource !== 'album') { cancelDismiss(); pending = null; paint(); } return; }
          if (pending?.source === 'share') return;
          cancelDismiss(); notice = ''; pending = { ...item, source: 'clipboard' }; hidden = false; paint();
          if (pending.kind === 'link') void previewLink(pending);
        }, onUnavailable: status });
        void store.sweep().catch(() => {});
        const saved = recovery();
        if (saved?.binding === binding && Array.isArray(saved.ids) && !saved.pending) {
          if (saved.ids.length && window.piRouteModules?.has('notes')) await window.piRouteModules.ensure('notes');
          if (epoch !== generation) return;
          if (!String(ui.notesDraft || '').trim() && typeof saved.text === 'string') ui.notesDraft = saved.text;
          for (const id of saved.ids.filter(store.validId)) if (!active.has(id)) {
            try {
              await lockShare(id);
              const row = await store.claim({ shareId: id, ownerBinding: binding, claimant });
              if (epoch !== generation) { releaseShare(id); return; }
              if (!noteImportImage({ intakeId: id, file: sharedFile(row), source: 'share' })) throw new Error('草稿附件已满，请处理后重试恢复');
              active.set(id, { expiresAt: row.expiresAt }); beginRenew();
              if (ui.view === 'notes') noteOpenComposer();
              await noteUploadIntake(id);
            } catch (error) { releaseShare(id); status(error.message || '分享草稿恢复失败，请重新分享'); }
          }
          if (active.size) { beginRenew(); if (ui.view === 'notes') noteOpenComposer(); }
        }
        const previousPending = saved?.binding === binding ? (saved.pendingIds || (saved.pending ? saved.ids : [])) : [];
        const url = new URL(location.href), ids = url.searchParams.getAll('shareId');
        if (ids.length === 1 && store.validId(ids[0])) {
          queuedShares = [...new Set(previousPending.filter(id => store.validId(id) && id !== ids[0] && !active.has(id)))];
          pending = { source: 'share', intakeId: ids[0], shareId: ids[0] };
          remember();
          url.searchParams.delete('shareId'); url.hash = '#/notes'; history.replaceState(null, '', url.pathname + url.search + url.hash);
          paint(); await importPending(true); return;
        }
        const errors = { invalid: '未收到有效图片，请重新分享 PNG、JPEG、WebP，或从相册上传（单张不超过 10 MiB）', full: '临时图片已满，请先保存或取消之前的分享', storage: '临时图片接收失败，请重新分享或从相册上传' };
        const error = url.searchParams.get('shareError');
        if (errors[error]) { status(errors[error]); url.searchParams.delete('shareError'); history.replaceState(null, '', url.pathname + url.search + '#/notes'); return; }
        if (!pending && previousPending.length) {
          queuedShares = previousPending.filter(id => store.validId(id) && !active.has(id));
          const id = queuedShares.shift();
          if (id) pending = { source: 'share', intakeId: id, shareId: id };
        }
        remember(); paint();
        if (pending?.source === 'share') await importPending(true);
      } catch { /* No live authorization: retain local data without exposing it. Manual paste remains available. */ }
    })().finally(() => { startFlight = null; });
    return startFlight;
  }
  async function beforeSave(ids) {
    if (!ids.length) return;
    const epoch = generation;
    let currentBinding;
    try { currentBinding = await authorize(); } catch (error) { await invalidate(); status(error.message); throw error; }
    if (!binding || binding !== currentBinding || epoch !== generation) {
      await invalidate(); status('访问状态已变化，图片未上传，请重新导入'); throw new Error('访问状态已变化，图片未上传，请重新导入');
    }
    for (const id of ids) if (active.has(id)) await store.renew(id, claimant);
    if (epoch !== generation) throw new Error('访问状态已变化，请重新导入');
  }
  async function saved(ids) {
    for (const id of ids) if (active.has(id)) {
      active.delete(id); releaseShare(id);
      try { await store.finish(id, claimant); } catch { status('待办已保存，临时图片将在过期后清理'); }
    }
    remember(); if (!active.size) clearInterval(renewTimer);
  }
  async function cancelled(id) { await saved([id]); }
  async function invalidate({ explicitLogout = false, remote = false } = {}) {
    const oldBinding = binding || lastBinding;
    remember(); cancelDismiss(); generation++; binding = null;
    linkPreview?.abort(); linkPreview = null;
    for (const controller of sessionUploads) controller.abort(); sessionUploads.clear();
    if (typeof rtRemoveIntakeImages === 'function') { rtRemoveIntakeImages('new'); for (const key of clipboardDraftKeys) rtRemoveIntakeImages(key); }
    clipboardDraftKeys.clear();
    if (typeof noteOperationEpoch !== 'undefined') noteOperationEpoch++;
    detector?.dispose(); detector = null; photoDetector?.dispose(); photoDetector = null; pending = null; queuedShares = []; importing = false; notice = ''; clearInterval(renewTimer);
    if (!remote) channel?.postMessage({ type: 'invalidate', binding: oldBinding, explicitLogout });
    if (typeof ui !== 'undefined') {
      for (const item of ui.notesImages || []) if (item.intakeId) { if (typeof noteReleaseLocalImage === 'function') noteReleaseLocalImage(item); }
      ui.notesImages = (ui.notesImages || []).filter(item => !item.intakeId);
      ui.notesBusy = '';
      if (typeof notePatchComposer === 'function') notePatchComposer();
    }
    active.clear(); for (const id of releases.keys()) releaseShare(id);
    if (explicitLogout) { try { sessionStorage.removeItem(RECOVERY); if (oldBinding) await store.clearBinding(oldBinding); } catch {} window.piClipboardHistory?.clear?.(); lastBinding = null; }
    paint();
  }
  async function importClipboard(key) {
    const item = pending, epoch = generation;
    if (!item || item.kind === 'link' || item.source !== 'clipboard' || importing || item.expiresAt <= Date.now()) return;
    if (rtImageDraft(key).images.length >= 5 || rtImageDraft(key).pending || ui.rt?.busy) return;
    importing = true; cancelDismiss(); paint();
    const controller = new AbortController(); sessionUploads.add(controller);
    try {
      const owner = await authorize();
      if (epoch !== generation || !binding || owner !== binding) throw new Error('访问状态已变化，请重新导入');
      const file = await intakeFile(item);
      await store.validate(file);
      if (epoch !== generation || pending !== item) return;
      clipboardDraftKeys.add(key);
      // Hand ownership to the draft immediately; failed uploads retain the file and existing retry control.
      (item.imageSource === 'album' ? photoDetector : detector)?.imported(item.intakeId); advance(item); notice = '';
      await rtAddImages(key, [file], { intakeId: item.intakeId, isCurrent: () => epoch === generation, signal: controller.signal, cancel: () => controller.abort() });
    } catch (error) {
      const message = error.message || '图片导入失败，请重试';
      window.piToast?.(message, { tone: 'warn' }); status(message);
    }
    finally { sessionUploads.delete(controller); importing = false; paint(); }
  }
  document.addEventListener('input', event => { if (event.target?.matches?.('.notes-input') && active.size) remember(); });
  phoneLayout.addEventListener('change', paint);
  window.addEventListener('hashchange', () => { if (pending?.kind === 'link') paint(); });
  window.addEventListener('pagehide', () => { remember(); clearInterval(renewTimer); for (const id of releases.keys()) releaseShare(id); });
  window.addEventListener('focus', () => { if (!binding) void start(); });
  window.imageIntake = Object.freeze({ linkGlyph: LINK_GLYPH, refresh: paint, act, clipboardPending: () => pending?.source === 'clipboard' && pending.expiresAt > Date.now() ? { ...pending, importing } : null, openUrl, importClipboard, start, beforeSave, saved, cancelled, invalidate, canDetectClipboard: () => !!window.piClipboardImages?.supported?.(), enableClipboard: async () => { if (!binding) await start(); await detector?.enable(); return !!window.piClipboardImages?.enabled?.(); }, showPending: () => { hidden = false; if (!pending) status('当前没有待处理图片，请粘贴或从相册添加'); else paint(); } });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void start(), { once: true }); else void start();
})();
