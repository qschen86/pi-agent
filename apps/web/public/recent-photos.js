/* Native album access is explicit; only one new image enters the existing intake flow.
   气泡只需要「有新图 + 一张小缩略图」，原图字节等用户点了才取（photos.image）：
   首屏不再为一张 30px 的圆点搬运几 MB 原图，也不再串行等照片状态和页面身份。 */
(() => {
  'use strict';
  const shell = window.piAndroidShell, preference = 'pi-agent:recent-photos:enabled:v1';
  // 拆成两个调用后缺一不可：只有 photos.latest 的旧包按「需要更新 APK」处理，不能假装能用。
  const REQUIRED = ['photos.latest', 'photos.image'];
  const CURSOR = 'pi-agent:recent-photos:scan:v1:';
  const MIMES = ['image/png', 'image/jpeg', 'image/webp'];
  let supported = false, permission = 'denied', optedIn = false, revision = 0;
  try { optedIn = localStorage.getItem(preference) === '1'; } catch {}
  const granted = () => ['full', 'limited'].includes(permission);
  const enabled = () => supported && optedIn && granted();
  const changed = () => window.dispatchEvent(new Event('pi-capabilities-change'));
  const notice = () => window.dispatchEvent(new Event('pi-recent-photos-change'));
  /** 记录原生回报的权限；变了才算一次设置变化，避免每次检测都重绘工具条。 */
  function apply(value) {
    const next = ['full', 'limited'].includes(value) ? value : 'denied';
    if (next === permission) return false;
    permission = next; revision++; return true;
  }
  /** 设置页与回前台时的权限核对；首次检测不等它 —— 权限已随 shell.status 一起回来。 */
  async function refresh() {
    if (!supported) return;
    if (apply((await shell.call('photos.status')).permission)) { changed(); notice(); }
  }
  const ready = shell?.available ? shell.call('shell.status').then(status => {
    const capabilities = Array.isArray(status.capabilities) ? status.capabilities : [];
    supported = !!status.photos && REQUIRED.every(name => capabilities.includes(name));
    if (status.photos) apply(status.photos.permission);
    changed();
  }).catch(() => {}) : Promise.resolve();
  function setEnabled(value, rescan = false) {
    optedIn = value; revision++;
    try { localStorage.setItem(preference, value ? '1' : '0'); } catch {}
    changed(); window.dispatchEvent(new CustomEvent('pi-recent-photos-change', { detail: { rescan } }));
  }
  window.addEventListener('storage', event => {
    if (event.key === preference || event.key === null) {
      optedIn = event.key !== null && event.newValue === '1'; revision++;
      changed(); notice();
    }
  });
  window.piRecentPhotos = Object.freeze({
    supported: () => supported, enabled, permission: () => permission,
    async enable() {
      await ready;
      if (!supported) throw new Error('请更新 Android APK 以开启相册新图片');
      const rescan = optedIn && permission !== 'full';
      const next = (await shell.call('photos.permission')).permission;
      apply(next);
      if (permission === 'denied') { changed(); throw new Error('未获得照片读取权限，请在系统设置中允许'); }
      setEnabled(true, rescan); return permission;
    },
    disable: () => setEnabled(false),
    create({ binding, onImage, onUnavailable }) {
      let owner = typeof binding === 'string' ? binding : '';
      let cursor = { checkedAt: 0, id: '', seenIds: [] }, disposed = false, epoch = 0, running = false, again = false, timer, expiry, current;
      // A save may notify before IS_PENDING clears. Keep a short lookback throughout
      // this bounded burst so an empty scan cannot move past the pending screenshot.
      const retryDelays = [250, 700, 1500];
      let burst = null;
      function loadCursor() {
        cursor = { checkedAt: 0, id: '', seenIds: [] };
        if (!owner) return;
        try {
          const saved = JSON.parse(localStorage.getItem(CURSOR + owner) || 'null');
          if (Number.isSafeInteger(saved?.checkedAt) && saved.checkedAt >= 0 && typeof saved.id === 'string') {
            const ids = Array.isArray(saved.seenIds) ? saved.seenIds.filter(id => typeof id === 'string' && id.length <= 40) : [];
            cursor = { checkedAt: saved.checkedAt, id: saved.id, seenIds: [...new Set([...ids, saved.id].filter(Boolean))].slice(-64) };
          }
        } catch {}
      }
      loadCursor();
      const active = () => !disposed && document.visibilityState === 'visible' && document.hasFocus();
      const clear = () => { clearTimeout(expiry); if (current) { current = null; onImage(null); } };
      /** 预览只有缩略图；[load] 才是点下去之后才走的取字节路径，同一张图只取一次。 */
      function albumItem(id, thumb) {
        let file = null, loading = null;
        const item = { intakeId: 'album-' + id, imageSource: 'album', expiresAt: Date.now() + 600000,
          thumb: typeof thumb === 'string' && thumb && thumb.length <= 512 * 1024 ? 'data:image/webp;base64,' + thumb : '' };
        item.load = () => {
          if (file) return Promise.resolve(file);
          loading ||= (async () => {
            const photo = await shell.call('photos.image', { id });
            if (!photo || String(photo.id) !== String(id) || typeof photo.data !== 'string') throw new Error('最新照片暂时无法读取，请重试');
            if (!MIMES.includes(photo.mime)) throw new Error('最新照片格式不受支持，请用加号选择');
            const bytes = Uint8Array.from(atob(photo.data), c => c.charCodeAt(0));
            if (!bytes.length || bytes.length > 10 * 1024 ** 2) throw new Error('最新照片不能超过 10 MiB，请用加号选择');
            file = new File([bytes], '最新照片.' + ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[photo.mime]), { type: photo.mime });
            return file;
          })().catch(error => { loading = null; throw error; });
          return loading;
        };
        return item;
      }
      async function read() {
        if (!active() || !enabled()) return;
        if (running) { again = true; return; }
        running = true; const generation = epoch, settings = revision, scanBurst = burst;
        try {
          const result = await shell.call('photos.latest', { after: scanBurst ? Math.min(cursor.checkedAt, scanBurst.after) : cursor.checkedAt });
          if (apply(result.permission)) { changed(); notice(); }
          if (!active() || !enabled() || generation !== epoch || settings !== revision) return;
          if (!Number.isSafeInteger(result.checkedAt) || result.checkedAt < 0) throw new Error('相册检查未完成，请重试');
          let nextId = cursor.id, seenIds = cursor.seenIds;
          if (result.id && result.id !== cursor.id && !seenIds.includes(result.id)) {
            if (!MIMES.includes(result.mime)) throw new Error('最新照片格式不受支持，请用加号选择');
            clearTimeout(expiry);
            const item = albumItem(result.id, result.thumb);
            current = item;
            if (onImage(item) === false) { current = null; return; }
            if (burst === scanBurst) burst = null;
            nextId = result.id; seenIds = [...seenIds, nextId].slice(-64); expiry = setTimeout(clear, 600000);
          }
          // Commit only after the response was accepted in this visible, authorized page.
          cursor = { checkedAt: result.checkedAt, id: nextId, seenIds };
          if (owner) { try { localStorage.setItem(CURSOR + owner, JSON.stringify(cursor)); } catch {} }
        } catch (error) {
          // 权限可能刚被系统收回：重读一次状态，仍可用才提示用户。
          void refresh().catch(() => {});
          if (!disposed && generation === epoch && settings === revision && enabled()) onUnavailable?.(error.message || '相册暂时无法读取');
        }
        finally {
          running = false;
          if (again && !disposed) { again = false; schedule(burst ? 180 : 30); }
          else if (burst && burst === scanBurst) {
            if (burst.retries < retryDelays.length) schedule(retryDelays[burst.retries++]);
            else burst = null;
          }
        }
      }
      function schedule(delay = 30) { if (!active() || !enabled()) return; clearTimeout(timer); timer = setTimeout(() => void read(), delay); }
      function changedPhotos(delay = 180) {
        if (!active() || !enabled()) return;
        burst = { after: burst?.after ?? Math.max(0, cursor.checkedAt - 5000), retries: 0 };
        schedule(delay);
      }
      const mediaChanged = () => changedPhotos();
      // 权限核对与检测并行：不再让一个 photos.status 往返挡在第一次查询前面。
      const foreground = () => { if (!active()) return; void refresh().catch(() => {}); changedPhotos(30); };
      const blur = () => { epoch++; burst = null; again = false; clearTimeout(timer); };
      const visibility = () => { if (document.visibilityState === 'visible') foreground(); else blur(); };
      const settingsChanged = event => { if (event.detail?.rescan) { blur(); cursor = { ...cursor, checkedAt: 0 }; } if (!enabled()) { blur(); clear(); } else schedule(); };
      /** 页面身份晚到时补上：游标按身份存，检测本身不必等它。 */
      function bindOwner(value) {
        const next = typeof value === 'string' ? value : '';
        if (next === owner) return;
        owner = next; blur(); loadCursor();
        // 身份晚到前可能按空游标扫到一张：这个身份已经处理过它的话，别再弹一次。
        if (current && (current.intakeId === 'album-' + cursor.id || cursor.seenIds.some(id => current.intakeId === 'album-' + id))) { current = null; clearTimeout(expiry); onImage(null); }
        schedule();
      }
      window.addEventListener('focus', foreground); window.addEventListener('blur', blur);
      window.addEventListener('pi-native-resume', foreground); window.addEventListener('pi-recent-photos-change', settingsChanged);
      window.addEventListener('pi-native-photos-change', mediaChanged);
      document.addEventListener('visibilitychange', visibility);
      void ready.then(schedule);
      const release = id => { if (current?.intakeId === id) { current = null; clearTimeout(expiry); } };
      return Object.freeze({ imported: release, dismiss: release, bindOwner, dispose() {
        disposed = true; blur(); clearTimeout(expiry);
        window.removeEventListener('focus', foreground); window.removeEventListener('blur', blur);
        window.removeEventListener('pi-native-resume', foreground); window.removeEventListener('pi-recent-photos-change', settingsChanged);
        window.removeEventListener('pi-native-photos-change', mediaChanged);
        document.removeEventListener('visibilitychange', visibility); current = null;
      } });
    }
  });
})();
