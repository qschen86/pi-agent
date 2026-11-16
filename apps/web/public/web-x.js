/* AI浏览器: an H5 container that collects your context. Only the trusted pi-Agent page calls native capabilities; the sites themselves only get a validated collect() bridge. */
(() => {
  const MODES = [
    { id: 'click', label: '点击采集', hint: '点帖子、视频或文章本身，点一下就记下。整条内容都是采集入口。' },
    { id: 'dwell', label: '浏览停留采集', hint: '同一页停留满设定秒数后自动记下，适合长文和视频。' },
    { id: 'button', label: '采集按钮', hint: '浏览器在每条内容旁嵌入一个采集按钮，只有按下按钮的那条才被记下。' },
  ];
  const MODE_LABEL = Object.fromEntries(MODES.map(m => [m.id, m.label]));
  const FALLBACK_SITES = [
    { id: 'x', name: 'X', host: 'x.com', mode: 'click', modeLabel: '点击采集' },
    { id: 'youtube', name: 'YouTube', host: 'm.youtube.com', mode: 'click', modeLabel: '点击采集' },
    { id: 'wechat', name: '微信公众号', host: 'mp.weixin.qq.com', mode: 'click', modeLabel: '点击采集' },
  ];
  const MARKS = { x: 'X', youtube: '▶', wechat: '✉' };
  const ORDER = ['x', 'youtube', 'wechat'];
  const siteName = id => (state.sites.find(s => s.id === id)?.name) || FALLBACK_SITES.find(s => s.id === id)?.name || id;

  const state = {
    checking: false, checked: false, supported: false, legacy: false, recordsSupported: false,
    sites: [], settings: { defaultMode: 'click', dwellSeconds: 6, perSite: {} },
    screen: 'dock', busy: false, savingSites: new Set(), siteErrors: {}, error: '', records: [], recordSite: '', total: 0,
    clipExpanded: false, clipClearAt: 0,
  };
  const redraw = () => { if (ui.view === 'web-x') renderMain(); };

  const shell = () => window.piAndroidShell;
  const has = caps => Array.isArray(caps) && caps.includes('browser.site.open');
  const localSettings = () => {
    try { return JSON.parse(localStorage.getItem('pi-agent:ai-browser:settings') || 'null') || null; } catch { return null; }
  };
  const rememberLocal = settings => { try { localStorage.setItem('pi-agent:ai-browser:settings', JSON.stringify(settings)); } catch {} };

  function check() {
    if (state.checked || state.checking) return;
    const api = shell();
    if (!api) { state.checked = true; state.sites = FALLBACK_SITES; return; }
    state.checking = true;
    api.status().then(result => {
      const caps = result.capabilities;
      state.supported = has(caps);
      state.legacy = !state.supported && Array.isArray(caps) && caps.includes('browser.x.open');
      state.recordsSupported = Array.isArray(caps) && caps.includes('browser.site.records');
      state.checked = true;
      if (!state.supported) { state.sites = FALLBACK_SITES; return; }
      return loadSettings();
    }).catch(() => { state.checked = true; state.error = '暂未读到 App 能力，请重试。'; })
      .finally(() => { state.checking = false; redraw(); });
  }

  async function loadSettings() {
    try {
      const result = await shell().call('browser.site.settings');
      state.settings = result.settings || state.settings;
      state.sites = (result.sites || []).sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
      if (result.sites?.length) return;
    } catch (error) { state.error = error.message || '采集设置读取失败'; }
    state.sites = FALLBACK_SITES;
    state.settings = localSettings() || state.settings;
  }

  // Native settings writes replace the whole document. Serialize them and build
  // each site patch from the last acknowledged value so fast taps cannot lose edits.
  let settingsQueue = Promise.resolve();
  function syncSite(siteId) {
    if (ui.view !== 'web-x') return;
    if (state.screen === 'settings') {
      const row = document.querySelector(`.aib-row[data-site="${siteId}"]`);
      const site = state.sites.find(site => site.id === siteId);
      if (row && site) row.replaceWith(settingsSiteRow(site));
      document.querySelectorAll('.aib-mode, .aib-stepper input, .aib-stepper button').forEach(control => {
        const bound = (control.getAttribute('aria-label') === '减少 1 秒' && seconds() <= 2) || (control.getAttribute('aria-label') === '增加 1 秒' && seconds() >= 60);
        control.disabled = state.busy || state.savingSites.size > 0 || bound;
      });
      return;
    }
    if (state.screen !== 'dock') return;
    const row = document.querySelector(`.aib-site[data-site="${siteId}"]`);
    if (!row) return;
    const chip = row.querySelector('.aib-mode-chip');
    const saving = state.savingSites.has(siteId);
    chip.disabled = saving;
    chip.setAttribute('aria-busy', String(saving));
    chip.textContent = saving ? '保存中…' : `${MODE_LABEL[modeOf(siteId)]} ▾`;
    const error = row.querySelector('.aib-site-error');
    error.textContent = state.siteErrors[siteId] || '';
    error.hidden = !state.siteErrors[siteId];
  }

  function saveSettings(next, siteId) {
    if (siteId) {
      if (state.savingSites.has(siteId)) return;
      state.savingSites.add(siteId);
      delete state.siteErrors[siteId];
      syncSite(siteId);
    } else { state.busy = true; redraw(); }
    const work = async () => {
      const value = typeof next === 'function' ? next(state.settings) : next;
      try {
        if (state.supported) {
          const result = await shell().call('browser.site.settings.set', { settings: value });
          state.settings = result.settings || value;
          state.sites = (result.sites || state.sites).sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
        } else { rememberLocal(value); state.settings = value; }
      } catch (error) {
        if (siteId) state.siteErrors[siteId] = error.message || '采集设置保存失败，请重试';
        else state.error = error.message || '采集设置保存失败';
      } finally {
        if (siteId) { state.savingSites.delete(siteId); syncSite(siteId); }
        else { state.busy = false; redraw(); }
      }
    };
    settingsQueue = settingsQueue.then(work);
    return settingsQueue;
  }

  async function open(site) {
    if (state.busy) return;
    if (!state.supported && !state.legacy) { state.error = '请升级 App 后使用内置浏览器'; redraw(); return; }
    state.busy = true; state.error = ''; redraw();
    try {
      if (state.supported) await shell().call('browser.site.open', { site: site.id });
      else await shell().call('browser.x.open');
    } catch (error) { state.error = error.message || `无法打开 ${site.name}，请重试。`; }
    finally { state.busy = false; redraw(); }
  }

  async function loadRecords(site = '') {
    if (!state.recordsSupported) return;
    state.busy = true; state.recordSite = site; redraw();
    try {
      const result = await shell().call('browser.site.records', site ? { site } : {});
      state.records = result.entries || []; state.total = result.total || state.records.length;
    } catch (error) { state.error = error.message || '采集记录读取失败'; }
    finally { state.busy = false; redraw(); }
  }

  const go = screen => { state.screen = screen; state.error = ''; if (screen === 'records') loadRecords(state.recordSite); else redraw(); };

  const modeOf = id => (state.settings.perSite && state.settings.perSite[id]) || state.settings.defaultMode;
  const seconds = () => Math.min(60, Math.max(2, Math.round(Number(state.settings.dwellSeconds) || 6)));

  function header(title, back) {
    return h('div', { class: 'web-x-head aib-head page-navigation-head' },
      h('div', { class: 'aib-head-text' }, h('h1', {}, title)),
      h('div', { class: 'page-navigation-actions' }, back
        ? h('button', { type: 'button', title: '返回站点坞', 'aria-label': '返回站点坞', onclick: () => go('dock') }, rtMiniIcon(['m15 18-6-6 6-6'], { size: 20 }))
        : [
          state.recordsSupported ? h('button', { type: 'button', title: '采集记录', 'aria-label': '采集记录', disabled: state.busy, onclick: () => go('records') }, rtClockIcon()) : null,
          h('button', { type: 'button', title: '采集设置', 'aria-label': '采集设置', disabled: !state.checked, onclick: () => go('settings') }, rtGearIcon()),
        ]));
  }

  function siteRow(site) {
    const mode = modeOf(site.id);
    return h('div', { class: 'aib-site', 'data-site': site.id },
      h('span', { class: `aib-mark ${site.id}`, 'aria-hidden': 'true' }, MARKS[site.id] || site.name.slice(0, 1)),
      h('div', { class: 'aib-site-main' },
        h('div', { class: 'aib-site-name' }, site.name),
        h('div', { class: 'muted small aib-site-meta' }, site.host)),
      h('div', { class: 'aib-site-side' },
        h('button', { type: 'button', class: 'aib-mode-chip', disabled: state.savingSites.has(site.id), 'aria-busy': String(state.savingSites.has(site.id)), title: `切换 ${site.name} 的采集方式`, onclick: () => cycleMode(site.id) }, state.savingSites.has(site.id) ? '保存中…' : `${MODE_LABEL[mode] || mode} ▾`),
        state.supported || (state.legacy && site.id === 'x')
          ? h('button', { type: 'button', class: 'btn primary aib-open', disabled: state.busy, onclick: () => open(site) }, state.busy ? '正在打开…' : '打开')
          : h('a', { class: 'btn aib-open', href: `https://${site.host}/`, target: '_blank', rel: 'noopener noreferrer' }, '浏览器打开')),
      h('p', { class: 'field-error aib-site-error', role: 'alert', hidden: !state.siteErrors[site.id] }, state.siteErrors[site.id] || ''));
  }

  function cycleMode(siteId) {
    const order = MODES.map(m => m.id);
    const current = modeOf(siteId);
    const next = order[(order.indexOf(current) + 1) % order.length];
    saveSettings(settings => ({ ...settings, perSite: { ...(settings.perSite || {}), [siteId]: next } }), siteId);
  }

  // The copied-link history lives on this home page only; site pages stay free of it.
  const clipStore = () => window.piClipboardHistory;
  const clipItems = () => clipStore()?.list?.() || [];
  const clipGlyph = () => window.imageIntake?.linkGlyph || '';
  const clipPath = item => clipStore()?.pathOf?.(item.url) || '';
  function clipLabel(item) {
    if (item.title) return item.title;
    const path = clipPath(item);
    return path && path !== '/' ? path : item.host || item.url;
  }
  function clipMark(item, className) {
    const mark = h('span', { class: className, 'aria-hidden': 'true' });
    const glyph = item?.favicon || clipGlyph();
    if (!glyph) { mark.textContent = '↗'; return mark; }
    const image = h('img', { alt: '', src: glyph });
    image.addEventListener('error', () => { if (clipGlyph() && image.src !== clipGlyph()) image.src = clipGlyph(); });
    mark.append(image);
    return mark;
  }
  async function clipOpen(item) {
    state.clipError = '';
    try {
      const pending = window.imageIntake?.clipboardPending?.();
      if (pending?.kind === 'link' && pending.url === item.url && window.imageIntake?.act) await window.imageIntake.act('open');
      else if (window.imageIntake?.openUrl) await window.imageIntake.openUrl(item.url);
      else throw new Error('请升级 App 以使用内置链接浏览');
    } catch (error) { state.clipError = error.message || '打开失败，请重试'; }
    syncClip();
  }
  async function clipIgnore(item) {
    state.clipError = '';
    try {
      const pending = window.imageIntake?.clipboardPending?.();
      if (pending?.kind === 'link' && pending.url === item.url && window.imageIntake?.act) await window.imageIntake.act('ignore');
      else window.piClipboardHistory?.remove?.(item.id);
    } catch (error) { state.clipError = error.message || '操作失败，请重试'; }
    syncClip();
  }
  function clipToggle() {
    state.clipExpanded = !state.clipExpanded;
    syncClip();
  }
  function clipClear() {
    if (Date.now() < state.clipClearAt) {
      window.piClipboardHistory?.clear?.();
      state.clipClearAt = 0;
    } else {
      state.clipClearAt = Date.now() + 4000;
      setTimeout(() => { if (state.clipClearAt && Date.now() >= state.clipClearAt) { state.clipClearAt = 0; syncClip(); } }, 4100);
    }
    syncClip();
  }
  function clipboardCard() {
    const items = clipItems();
    if (!items.length) {
      const api = window.piClipboardImages;
      const supported = !!api?.supported?.();
      const enabled = !!api?.enabled?.();
      const text = !supported
        ? '当前环境不支持读取剪贴板，可手动粘贴链接。'
        : enabled ? '复制一个链接后回到 App，最新一条会显示在这里。'
        : '在「系统设置 → 通用能力」开启「剪贴板图片与链接识别」后开始记录。';
      return h('div', { class: 'card aib-clip aib-clip-empty', role: 'group', 'aria-label': '最近剪贴板' },
        clipMark(null, 'aib-clip-mark'),
        h('div', { class: 'aib-clip-main' },
          h('div', { class: 'aib-clip-label' }, '最近剪贴板'),
          h('p', { class: 'aib-clip-empty-text' }, text)));
    }
    const latest = items[0];
    if (items.length <= 1) state.clipExpanded = false;
    const expanded = state.clipExpanded && items.length > 1;
    const time = clipStore()?.formatTime?.(latest.at) || '';
    const full = clipStore()?.formatFull?.(latest.at) || '';
    const path = clipPath(latest);
    return h('div', { class: 'card aib-clip', role: 'group', 'aria-label': '最近剪贴板' },
      h('div', { class: 'aib-clip-head' },
        h('span', { class: 'aib-clip-label' }, '最近剪贴板'),
        h('div', { class: 'aib-clip-head-right' },
          h('time', { class: 'aib-clip-time', datetime: new Date(latest.at).toISOString(), title: full }, time),
          items.length > 1 ? h('button', { type: 'button', class: 'aib-clip-toggle', 'aria-expanded': String(expanded), 'data-clip-focus': 'toggle', onclick: clipToggle }, expanded ? '收起历史' : `历史 ${items.length} 条`) : null)),
      h('div', { class: 'aib-clip-latest' },
        clipMark(latest, 'aib-clip-mark'),
        h('div', { class: 'aib-clip-main' },
          h('button', { type: 'button', class: 'aib-clip-title', title: latest.url, 'data-clip-focus': 'open-latest', onclick: () => void clipOpen(latest) }, clipLabel(latest)),
          h('div', { class: 'aib-clip-host' }, h('span', {}, latest.host || ''), path && path !== '/' ? h('span', { class: 'aib-clip-path' }, path) : null)),
        h('div', { class: 'aib-clip-actions' },
          h('button', { type: 'button', class: 'btn primary aib-open', 'data-clip-focus': 'open', onclick: () => void clipOpen(latest) }, '打开'),
          h('button', { type: 'button', class: 'btn ghost aib-clip-ignore', 'aria-label': '忽略剪贴板链接', 'data-clip-focus': 'ignore', onclick: () => void clipIgnore(latest) }, '忽略'))),
      state.clipError ? h('p', { class: 'field-error aib-clip-error', role: 'alert' }, state.clipError) : null,
      expanded ? h('div', { class: 'aib-clip-history' },
        ...items.map(item => h('div', { class: 'aib-clip-row', 'data-clip-id': item.id },
          clipMark(item, 'aib-clip-row-mark'),
          h('div', { class: 'aib-clip-row-main' },
            h('button', { type: 'button', class: 'aib-clip-row-title', title: item.url, 'data-clip-focus': `open:${item.id}`, onclick: () => void clipOpen(item) }, clipLabel(item)),
            h('div', { class: 'aib-clip-row-meta' },
              h('time', { datetime: new Date(item.at).toISOString(), title: clipStore()?.formatFull?.(item.at) || '' }, clipStore()?.formatTime?.(item.at) || ''),
              h('span', { class: 'aib-clip-row-url' }, `${item.host || ''}${clipPath(item)}`))),
          h('button', { type: 'button', class: 'aib-clip-row-remove', 'aria-label': `删除剪贴板记录：${clipLabel(item)}`, 'data-clip-focus': `remove:${item.id}`, onclick: () => { window.piClipboardHistory?.remove?.(item.id); syncClip(); } }, '✕'))),
        h('div', { class: 'aib-clip-history-foot' },
          h('span', { class: 'muted small' }, '只保存在本机 · 北京时间'),
          h('button', { type: 'button', class: 'btn ghost aib-clip-clear', 'data-clip-focus': 'clear', onclick: clipClear }, Date.now() < state.clipClearAt ? '再点一次清空' : '清空记录')))
      : null);
  }
  // Patch only the card: image-intake dispatches this event from inside paint(), and a full re-render can re-enter it.
  function syncClip() {
    if (ui.view !== 'web-x' || state.screen !== 'dock') return;
    const old = document.querySelector('.aib-clip'), next = clipboardCard();
    const focus = old?.contains(document.activeElement) ? document.activeElement.getAttribute?.('data-clip-focus') : '';
    if (old && next) old.replaceWith(next);
    else if (old) old.remove();
    else if (next) document.querySelector('.aib-page .aib-list')?.after(next);
    if (focus) (document.querySelector(`.aib-clip [data-clip-focus="${focus}"]`) || document.querySelector('.aib-clip-toggle'))?.focus();
  }
  window.addEventListener('pi-clipboard-pending-change', syncClip);
  window.addEventListener('pi-clipboard-history-change', syncClip);
  window.addEventListener('pi-capabilities-change', syncClip);

  function dock() {
    return h('section', { class: 'web-x-page aib-page' },
      header('AI浏览器', false),
      h('div', { class: 'aib-section-head' }, h('h2', {}, '站点坞'), h('span', { class: 'muted small' }, `${state.sites.length} 个站点 · 登录状态留在手机`)),
      h('div', { class: 'card aib-list' }, state.sites.map(siteRow)),
      clipboardCard(),
      state.checking ? h('p', { class: 'muted small', role: 'status' }, '正在检查 App 支持…') : null,
      state.error ? h('p', { class: 'field-error', role: 'alert' }, state.error) : null,
      state.error && !state.supported && !state.checking ? h('button', { type: 'button', class: 'btn', onclick: () => { state.error = ''; state.checked = false; check(); } }, '重试检查') : null,
      state.checked && !state.supported && !state.error
        ? h('p', { class: 'muted small' }, state.legacy ? '当前 App 只支持 X；升级后可使用 YouTube、微信公众号与三种采集方式。' : (shell() ? '请升级至支持 AI浏览器 的 APK，并使用 Android 9 或更高版本。' : 'App 内浏览需使用 Android 客户端；下面每项都可以在浏览器打开。'))
        : null,
      h('p', { class: 'muted small aib-note' }, '站点登录、页面正文与采集记录都留在手机；进入记忆前逐条确认。'));
  }

  function settingsSiteRow(site) {
    return h('div', { class: 'aib-row', 'data-site': site.id },
      h('div', {}, h('div', { class: 'aib-key' }, `${site.name} 的采集方式`), h('div', { class: 'muted small' }, site.host)),
      h('div', { class: 'inpage-tabs' }, MODES.map(item =>
        h('button', { type: 'button', class: modeOf(site.id) === item.id ? 'active' : '', disabled: state.busy || state.savingSites.has(site.id), onclick: () => saveSettings(settings => ({ ...settings, perSite: { ...(settings.perSite || {}), [site.id]: item.id } }), site.id) }, item.label))),
      state.savingSites.has(site.id) ? h('span', { class: 'muted small', role: 'status' }, '保存中…') : null,
      state.siteErrors[site.id] ? h('p', { class: 'field-error aib-site-error', role: 'alert' }, state.siteErrors[site.id]) : null);
  }

  function settingsScreen() {
    const mode = state.settings.defaultMode;
    return h('section', { class: 'web-x-page aib-page' },
      header('采集设置', true),
      h('div', { class: 'aib-section-head' }, h('h2', {}, '采集方式'), h('span', { class: 'muted small' }, '全局默认，可单站点覆盖')),
      h('div', { class: 'aib-modes' }, MODES.map(item =>
        h('button', { type: 'button', class: 'aib-mode', 'aria-pressed': String(mode === item.id), disabled: state.busy || state.savingSites.size > 0, onclick: () => saveSettings({ ...state.settings, defaultMode: item.id }) },
          h('div', { class: 'aib-mode-top' }, h('h3', {}, item.label), h('span', { class: 'aib-radio', 'aria-hidden': 'true' })),
          h('p', {}, item.hint)))),
      h('div', { class: 'card aib-rows' },
        h('div', { class: 'aib-row' },
          h('div', {}, h('div', { class: 'aib-key' }, '停留阈值'), h('div', { class: 'muted small' }, '切后台即停 · 2–60 秒')),
          h('div', { class: 'aib-stepper' },
            h('button', { type: 'button', 'aria-label': '减少 1 秒', disabled: state.busy || state.savingSites.size > 0 || seconds() <= 2, onclick: () => saveSettings({ ...state.settings, dwellSeconds: seconds() - 1 }) }, '−'),
            h('input', { type: 'number', min: '2', max: '60', step: '1', 'aria-label': '停留秒数', value: String(seconds()), disabled: state.busy || state.savingSites.size > 0, onchange: event => saveSettings({ ...state.settings, dwellSeconds: Math.min(60, Math.max(2, Math.round(Number(event.target.value) || 6))) }) }),
            h('span', { class: 'muted small' }, '秒'),
            h('button', { type: 'button', 'aria-label': '增加 1 秒', disabled: state.busy || state.savingSites.size > 0 || seconds() >= 60, onclick: () => saveSettings({ ...state.settings, dwellSeconds: seconds() + 1 }) }, '+'))),
        state.sites.map(settingsSiteRow)),
      state.error ? h('p', { class: 'field-error', role: 'alert' }, state.error) : null,
      h('div', { class: 'card aib-explainer' },
        h('p', {}, h('b', {}, '点击采集'), '：整条内容都是入口，点帖子本身即可，最适合刷信息流。'),
        h('p', {}, h('b', {}, '采集按钮'), '：内容旁多一个采集按钮，点内容不会触发，误触最少。'),
        h('p', {}, h('b', {}, '浏览停留采集'), '：完全不动手，只看你停留够久的那一页。'),
        h('p', { class: 'muted small' }, '同一个站点只启用一种，避免重复记录。')));
  }

  function recordsScreen() {
    const filters = [{ id: '', name: '全部' }, ...state.sites.map(s => ({ id: s.id, name: s.name }))];
    return h('section', { class: 'web-x-page aib-page' },
      header('采集记录', true),
      h('div', { class: 'inpage-tabs aib-filters' }, filters.map(f =>
        h('button', { type: 'button', class: state.recordSite === f.id ? 'active' : '', disabled: state.busy, onclick: () => loadRecords(f.id) }, f.name))),
      state.records.length === 0
        ? h('div', { class: 'card aib-empty' }, state.busy ? '正在读取…' : '还没有采集记录。')
        : h('div', { class: 'card aib-list' }, state.records.map(entry =>
          h('div', { class: 'aib-rec' },
            h('span', { class: 'aib-rec-mark', 'aria-hidden': 'true' }, MARKS[entry.site] || entry.site.slice(0, 1)),
            h('div', { class: 'aib-rec-main' },
              h('div', { class: 'aib-rec-title' }, entry.title),
              h('div', { class: 'muted small aib-rec-meta' }, `${entry.modeLabel} · ${siteName(entry.site)} · ${formatTime(entry.last)}`)),
            h('a', { class: 'btn aib-rec-open', href: entry.url, target: '_blank', rel: 'noopener noreferrer' }, '打开')))),
      state.error ? h('p', { class: 'field-error', role: 'alert' }, state.error) : null,
      h('p', { class: 'muted small aib-note' }, '采集不上传正文；记录只在本机，最多保存 10000 条。'));
  }

  function formatTime(value) {
    const date = new Date(Number(value) || 0);
    if (Number.isNaN(date.getTime())) return '';
    const now = Date.now();
    const sameDay = date.toDateString() === new Date(now).toDateString();
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return sameDay ? `今天 ${time}` : `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${time}`;
  }

  function renderWebX() {
    check();
    if (state.screen === 'settings') return settingsScreen();
    if (state.screen === 'records') return recordsScreen();
    return dock();
  }
  window.renderWebX = renderWebX;
  window.piRouteModules?.register('web-x', { render: renderWebX });
})();
