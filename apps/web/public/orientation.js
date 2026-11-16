// One owner for the console's orientation, including embedded games.
(() => {
  const KEY = 'pi-keep-portrait';
  const GAME = /^#\/artifacts\/games\/[a-z][a-z0-9-]*$/;
  const mobile = matchMedia('(pointer: coarse)').matches;
  let keep = true;
  try { keep = localStorage.getItem(KEY) !== '0'; } catch { /* default remains on */ }
  let route = location.hash, landscape = false, revision = 0, running = null, gameEpoch = 0, ownFullscreen = false;
  let prompt = null, notice = '', storageNotice = '', failure = '', activating = false, portraitFullscreen = false;
  const inGame = () => GAME.test(location.hash);
  const supported = () => typeof screen.orientation?.lock === 'function';
  const fallback = '当前浏览器未能锁定方向，请使用系统的竖屏锁定。';
  const publish = () => window.dispatchEvent(new Event('pi-orientation-change'));
  const target = () => landscape && inGame() ? 'landscape' : keep ? 'portrait' : 'any';

  // Serialize OS requests: an old landscape request may finish after game exit.
  // Always apply the newest target afterwards, and never publish a stale success.
  function apply() {
    revision++;
    if (running) return running;
    if (!mobile) return Promise.resolve();
    if (!supported()) { landscape = false; failure = 'API 不可用'; notice = fallback; publish(); return Promise.resolve(); }
    running = (async () => {
      await Promise.resolve();
      let processed;
      do {
        processed = revision;
        const wanted = target();
        try {
          await screen.orientation.lock(wanted);
          if (processed === revision) { failure = ''; notice = wanted === 'portrait' ? '已保持竖屏' : wanted === 'landscape' ? '本次游戏已切换横屏' : '已跟随系统方向'; }
        } catch (error) {
          if (processed === revision) { failure = error?.name || 'Error'; notice = fallback; landscape = false; }
        }
      } while (processed !== revision);
    })().finally(() => { running = null; publish(); });
    return running;
  }

  function restorePortrait() {
    gameEpoch++;
    prompt?.cancel();
    landscape = false;
    const exit = (ownFullscreen && !portraitFullscreen) || (portraitFullscreen && !keep);
    if (exit && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    if (!keep) portraitFullscreen = false;
    ownFullscreen = false;
    void apply();
  }

  function setEnabled(value) {
    keep = !!value;
    storageNotice = '';
    try { localStorage.setItem(KEY, keep ? '1' : '0'); }
    catch { storageNotice = '本设备无法保存偏好，重新打开后会恢复默认。'; }
    restorePortrait();
    publish();
  }

  // Some Android browsers reject script orientation locks outside actual fullscreen,
  // even when launched from a home-screen shortcut. This must start in a user click.
  async function requestPortrait() {
    if (!mobile || !keep || !supported() || activating) return false;
    activating = true; publish();
    const epoch = gameEpoch;
    let entered = false;
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        entered = true;
        portraitFullscreen = true;
      }
      if (!keep || epoch !== gameEpoch) {
        if (entered && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        if (entered) portraitFullscreen = false;
        return false;
      }
      landscape = false;
      await apply();
      return !failure && keep;
    } catch (error) {
      failure = error?.name || 'Error'; notice = fallback;
      return false;
    } finally { activating = false; publish(); }
  }

  function requestLandscape() {
    if (!inGame() || !mobile) return Promise.resolve(false);
    if (prompt) return prompt.result;
    const from = location.hash, epoch = gameEpoch, focus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'orientation-dialog';
    dialog.setAttribute('aria-labelledby', 'orientation-confirm-title');
    dialog.innerHTML = '<h2 id="orientation-confirm-title">切换为横屏？</h2><p>仅用于本次游戏，退出游戏后恢复屏幕方向设置。</p><div class="orientation-actions"><button type="button" class="btn" autofocus>保持竖屏</button><button type="button" class="btn primary">切换横屏</button></div>';
    let resolve, approved = false;
    const result = new Promise(done => { resolve = done; });
    function close() {
      dialog.close(); dialog.remove();
      if (prompt?.dialog === dialog) prompt = null;
      if (focus?.isConnected) focus.focus();
      if (!approved) resolve(false);
    }
    prompt = { dialog, result, cancel: close };
    const [cancel, confirm] = dialog.querySelectorAll('button');
    cancel.onclick = () => { close(); restorePortrait(); };
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); restorePortrait(); });
    confirm.onclick = async () => {
      approved = true; close();
      // Fullscreen must start in the confirm click's activation, never on a sensor event.
      try {
        if (supported() && !document.fullscreenElement && document.fullscreenEnabled) {
          await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
          ownFullscreen = true;
        }
      } catch { /* lock itself determines whether the environment permits it */ }
      if (location.hash !== from || epoch !== gameEpoch || !inGame()) {
        if (ownFullscreen && !portraitFullscreen && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        ownFullscreen = false;
        resolve(false); return;
      }
      landscape = true;
      await apply();
      if (notice === fallback) {
        window.piToast('未能切换横屏，当前设备或浏览器不支持。可检查系统方向锁定后重试。', { ms: 6000 });
      }
      resolve(landscape && inGame());
    };
    document.body.append(dialog); dialog.showModal();
    return result;
  }

  window.piOrientation = {
    enabled: () => keep, mobile: () => mobile, inGame, setEnabled, requestLandscape, requestPortrait, restorePortrait,
    canActivate: () => mobile && keep && supported() && !!failure,
    activating: () => activating,
    status: () => [mobile ? (failure ? `尚未锁定方向（${failure}）。${supported() && keep ? '可点下方按钮进入全屏重试；若仍失败，请使用系统竖屏锁定。' : '请使用系统的屏幕方向设置。'}` : notice || '正在尝试锁定方向…') : '仅在手机和平板上应用方向设置。', storageNotice].filter(Boolean).join(' '),
  };
  window.addEventListener('hashchange', () => {
    if (route === location.hash) return;
    route = location.hash;
    restorePortrait();
  });
  document.addEventListener('fullscreenchange', () => {
    // Leaving fullscreen can revoke an OS lock. Return to the saved preference.
    if (!document.fullscreenElement) { landscape = false; ownFullscreen = false; portraitFullscreen = false; }
    void apply();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void apply(); });
  window.addEventListener('pageshow', () => void apply());
  window.addEventListener('storage', event => {
    if (event.key === KEY || event.key === null) {
      try { keep = localStorage.getItem(KEY) !== '0'; } catch { return; }
      restorePortrait(); publish();
    }
  });
  void apply();
})();
