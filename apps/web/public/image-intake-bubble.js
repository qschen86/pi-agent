/* 手机「＋」上方的最新图片气泡：有新相册图 / 剪贴板图时出现在加号正上方，长按后向三个方向滑动选择去处。
   会话页：左 = 新建会话，上 = 创建待办，下 = 忽略；待办页：上 = 新建会话，左 = 创建待办，下 = 忽略。
   点一下气泡则展开同样三个按钮（键盘 / 不想拖动时用）。实际导入由 imageIntake.act() 完成。 */
(() => {
  'use strict';
  const HOLD_MS = 200, PICK_PX = 30, DRIFT_CANCEL_PX = 220, SIZE = 46, GAP = 10, REACH = 84;
  const LABELS = { session: '新建会话', notes: '创建待办', ignore: '忽略' };
  const LAYOUT = {
    sessions: { left: 'session', up: 'notes', down: 'ignore' },
    notes: { up: 'session', left: 'notes', down: 'ignore' }
  };
  const OFFSET = { left: [-REACH, 0], right: [REACH, 0], up: [0, -REACH], down: [0, REACH] };
  const isLink = () => window.imageIntake?.clipboardPending?.()?.kind === 'link';
  let bubble, img, previewKey, previewUrl = '', menu = null, gesture = null, observer = null, raf = 0, page = '';
  const buzz = pattern => { try { navigator.vibrate?.(pattern); } catch { /* 不支持震动的设备静默跳过 */ } };
  const GLYPH = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a8a85" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="2.5"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.4-2h5.2L16 6"/></svg>');

  /** 当前页面上可见的手机「＋」：会话列表的 .rt-new-btn 或待办页的 .notes-new-fab（都是 fixed 才算手机形态）。 */
  function findFab() {
    for (const [selector, kind] of [['.notes-new-fab', 'notes'], ['.rt-new-btn', 'sessions']]) {
      const el = document.querySelector(selector);
      if (!el || !el.getClientRects().length) continue;
      const style = getComputedStyle(el);
      if (style.position !== 'fixed' || style.visibility === 'hidden') continue;
      return { el, kind };
    }
    return null;
  }
  function previewSource(item) {
    const source = item?.kind === 'link' ? item.favicon || window.imageIntake.linkGlyph : item?.thumb || item?.file;
    if (previewKey !== source) {
      if (previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
      previewKey = source;
      previewUrl = !source ? '' : typeof source === 'string' ? source : URL.createObjectURL(source);
    }
    return previewUrl;
  }
  function ensureBubble() {
    if (bubble?.isConnected) return bubble;
    bubble = document.createElement('button');
    bubble.type = 'button'; bubble.className = 'image-intake-bubble'; bubble.hidden = true; bubble.draggable = false;
    bubble.setAttribute('aria-haspopup', 'true');
    bubble.addEventListener('contextmenu', ev => ev.preventDefault());
    bubble.addEventListener('pointerdown', onDown);
    // 键盘（Enter / 空格）没有指针序列：detail === 0 的 click 直接展开按钮菜单。
    bubble.addEventListener('click', ev => { if (ev.detail === 0 && !bubble.classList.contains('is-busy')) openMenu(true); });
    img = document.createElement('img'); img.alt = ''; img.setAttribute('aria-hidden', 'true'); img.draggable = false;
    img.addEventListener('error', () => { const fallback = isLink() ? window.imageIntake.linkGlyph : GLYPH; if (img.src !== fallback) img.src = fallback; });
    bubble.append(img);
    const badge = document.createElement('span'); badge.className = 'link-intake-badge'; badge.setAttribute('aria-hidden', 'true');
    badge.style.backgroundImage = `url("${window.imageIntake?.linkGlyph || GLYPH}")`; bubble.append(badge);
    document.body.append(bubble);
    return bubble;
  }
  /** 重新对齐：显隐、位置、预览图、标签。返回是否可见。 */
  function sync() {
    raf = 0;
    const item = window.imageIntake?.clipboardPending?.();
    const fab = item ? findFab() : null;
    const wasShown = !!bubble && !bubble.hidden;
    if (!item || !fab) {
      if (bubble) bubble.hidden = true;
      closeMenu();
      if (!item && previewUrl) { if (previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl); previewUrl = ''; previewKey = undefined; }
      stopObserving(!item);
      if (wasShown) window.imageIntake?.refresh?.();
      return false;
    }
    ensureBubble();
    page = fab.kind;
    const rect = fab.el.getBoundingClientRect();
    const label = item.kind === 'link' ? '剪贴板链接：点按浏览，长按选择操作' : item.imageSource === 'album' ? '最新照片：长按后滑动选择去处' : '剪贴板图片：长按后滑动选择去处';
    bubble.classList.toggle('is-link', item.kind === 'link');
    bubble.setAttribute('aria-label', label); bubble.title = label;
    img.src = previewSource(item) || GLYPH;
    // 导入中不用 disabled：disabled 的按钮收不到触摸，长按只剩系统自带的震动、什么反馈都没有（见 onDown 的提示）
    bubble.classList.toggle('is-busy', !!item.importing); bubble.setAttribute('aria-busy', item.importing ? 'true' : 'false');
    bubble.style.left = Math.round(rect.left + rect.width / 2 - SIZE / 2) + 'px';
    bubble.style.top = Math.round(rect.top - GAP - SIZE) + 'px';
    bubble.hidden = false;
    observeLayout();
    // 气泡接管了入口：顶部那张提示卡不再重复出现
    if (!wasShown) window.imageIntake?.refresh?.();
    return true;
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(sync); };
  /** 加号可能随路由重绘 / 换位置：有待处理图片期间才盯着 DOM，没有就不白耗。 */
  function observeLayout() {
    if (observer) return;
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
  }
  function stopObserving(force) { if (force && observer) { observer.disconnect(); observer = null; } }

  // ---- 方向菜单 ----
  function closeMenu() {
    gesture?.finish(); gesture = null;
    if (!menu) return;
    menu.dismissKey?.();
    menu.layer.remove();
    bubble?.classList.remove('is-holding');
    menu = null;
  }
  function buildLayer(sticky) {
    const layer = document.createElement('div');
    layer.className = 'image-intake-radial'; layer.setAttribute('role', 'group'); layer.setAttribute('aria-label', isLink() ? '剪贴板链接操作' : '最新图片去处');
    const bubbleRect = bubble.getBoundingClientRect();
    const cx = bubbleRect.left + SIZE / 2, cy = bubbleRect.top + SIZE / 2;
    const options = {};
    for (const [originalDir, action] of Object.entries(LAYOUT[page] || LAYOUT.sessions)) {
      const dir = isLink() && originalDir === 'left' && cx < innerWidth / 2 ? 'right' : originalDir;
      const [dx, dy] = OFFSET[dir];
      const el = document.createElement(sticky ? 'button' : 'div');
      if (sticky) el.type = 'button';
      el.className = `image-intake-option is-${action}`; el.dataset.action = action; el.dataset.dir = dir;
      // 选项圆心落在气泡圆心的上 / 左 / 下方；贴边时往里收，别被屏幕切掉
      const half = 32;
      const x = Math.min(Math.max(cx + dx, half + 6), innerWidth - half - 6), y = Math.min(Math.max(cy + dy, half + 6), innerHeight - half - 6);
      el.style.left = Math.round(x - half) + 'px'; el.style.top = Math.round(y - half) + 'px';
      el.textContent = isLink() ? { session: '发起会话', notes: '记录待办', ignore: '忽略' }[action] : LABELS[action];
      if (sticky) el.addEventListener('click', () => { const chosen = action; closeMenu(); void run(chosen); });
      layer.append(el); options[dir] = el;
    }
    if (isLink()) {
      const centre = document.createElement('button'); centre.type = 'button'; centre.className = 'link-intake-centre'; centre.setAttribute('aria-label', '打开链接');
      centre.style.left = bubbleRect.left + 'px'; centre.style.top = bubbleRect.top + 'px';
      const icon = img.cloneNode(), opened = Date.now(); centre.append(icon);
      // The release of the opening long press can synthesize a click on this newly inserted centre.
      centre.addEventListener('click', () => { if (Date.now() - opened < 350) return; closeMenu(); void run('open'); }); layer.append(centre);
    }
    // 触屏上抬手补发的那下 click 会落在刚弹出的遮罩上，不能把刚展开的按钮又关掉
    if (sticky) { const opened = Date.now(); layer.addEventListener('click', ev => { if (ev.target === layer && Date.now() - opened > 350) closeMenu(); }); }
    document.body.append(layer);
    return { layer, options, cx, cy };
  }
  function openMenu(sticky) {
    if (menu || !bubble || bubble.hidden) return;
    const built = buildLayer(sticky);
    menu = { ...built, sticky, active: null };
    bubble.classList.add('is-holding');
    if (sticky) {
      menu.layer.classList.add('is-sticky');
      const onKey = ev => { if (ev.key === 'Escape') { const target = bubble; closeMenu(); target?.focus(); } };
      document.addEventListener('keydown', onKey, true);
      menu.dismissKey = () => document.removeEventListener('keydown', onKey, true);
      menu.layer.querySelector('button')?.focus();
    }
  }
  /** 由手指相对气泡圆心的位移得出方向：太近不选；横竖取位移更大的一边；没有「右」选项。 */
  function pick(dx, dy) {
    if (Math.hypot(dx, dy) < PICK_PX || Math.hypot(dx, dy) > DRIFT_CANCEL_PX) return null;
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
    return dir && menu?.options[dir] ? dir : null;
  }
  function setActive(dir) {
    if (!menu || menu.active === dir) return;
    if (menu.active) menu.options[menu.active].classList.remove('is-active');
    menu.active = dir;
    if (dir) { menu.options[dir].classList.add('is-active'); buzz(8); }
  }
  async function run(action) {
    try { await window.imageIntake?.act?.(action); } catch (error) { window.piToast?.(error?.message || '图片导入失败，请重试', { tone: 'warn' }); }
    schedule();
  }
  function onDown(ev) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    closeMenu();
    if (window.piOtherTouchDown?.(ev)) return; // 多指（三指截图）不是长按
    if (bubble.classList.contains('is-busy')) { buzz(8); window.piToast?.('上一张图片还在导入，请稍候', { tone: 'warn' }); return; }
    const startX = ev.clientX, startY = ev.clientY, pointerId = ev.pointerId;
    let holding = false, timer = 0;
    const finish = () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
    };
    const move = e => {
      if (e.pointerId !== pointerId) return;
      if (!holding) { if (Math.hypot(e.clientX - startX, e.clientY - startY) > 14) closeMenu(); return; } // 没按够就拖走：既不是点也不是长按
      if (menu) setActive(pick(e.clientX - menu.cx, e.clientY - menu.cy));
    };
    const up = e => {
      if (e.pointerId !== pointerId) return;
      const chosen = holding && menu?.active ? menu.options[menu.active].dataset.action : '';
      const tapped = !holding;
      // 第一次长按震动后原地松手：转成可点菜单，不把刚展开的选项立即收掉。
      const releasedAtCentre = holding && menu && Math.hypot(e.clientX - menu.cx, e.clientY - menu.cy) < PICK_PX;
      closeMenu();
      if (tapped && isLink()) void run('open');
      else if (tapped || releasedAtCentre) openMenu(true);
      else if (chosen) { buzz([10, 30, 10]); void run(chosen); }
      if (e.cancelable) e.preventDefault();
    };
    // 长按已经震动、菜单已展开时被系统截断（安卓长按手势会抛 pointercancel）：留下可点菜单，别让菜单一闪就没
    const cancel = e => {
      if (e.pointerId !== pointerId) return;
      const keep = holding && menu && !menu.sticky;
      closeMenu();
      if (keep) openMenu(true);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    timer = setTimeout(() => { holding = true; buzz(20); openMenu(false); }, HOLD_MS);
    gesture = { finish };
  }
  window.addEventListener('pi-clipboard-pending-change', schedule);
  window.addEventListener('hashchange', schedule);
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  window.addEventListener('orientationchange', schedule);
  window.addEventListener('pi-recent-photos-change', schedule);
  window.piImageIntakeBubble = Object.freeze({ sync, pick, layout: LAYOUT });
  schedule();
})();
