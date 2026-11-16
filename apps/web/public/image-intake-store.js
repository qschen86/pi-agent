/* Shared by the page and worker. Local blobs never enter the static cache. */
(() => {
  'use strict';
  const TTL = 3600000, LEASE = 30000, LIMIT = 10 * 1024 ** 2;
  const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
  const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  function transaction(mode, action) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('pi-agent-image-intake', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('images', { keyPath: 'shareId' });
      open.onerror = () => reject(new Error('临时图片存储不可用，请从相册上传'));
      open.onblocked = () => reject(new Error('临时图片存储被占用，请重试'));
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('images', mode), store = tx.objectStore('images');
        let result, failure;
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(failure || new Error('临时图片存储失败，请重试')); };
        const request = store.getAll();
        request.onsuccess = () => {
          try { result = action(store, request.result); }
          catch (error) { failure = error; tx.abort(); }
        };
      };
    });
  }
  async function validate(file) {
    if (!file || !['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('只支持 PNG、JPEG、WebP 图片');
    if (!file.size || file.size > LIMIT) throw new Error('图片不能为空，且不能超过 10 MiB');
    const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const png = b.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i) => b[i] === n);
    const jpg = b[0] === 255 && b[1] === 216 && b[2] === 255;
    const webp = String.fromCharCode(...b.slice(0,4)) === 'RIFF' && String.fromCharCode(...b.slice(8,12)) === 'WEBP';
    if (!(file.type === 'image/png' ? png : file.type === 'image/jpeg' ? jpg : webp)) throw new Error('图片内容与格式不匹配');
    // Header checks are available in both worker and page; decode catches damaged images.
    if (typeof createImageBitmap === 'function') {
      let bitmap;
      try { bitmap = await createImageBitmap(file); if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 64 * 1024 ** 2) throw new Error(); }
      catch { throw new Error('图片无法解码或尺寸过大，请重新截图'); }
      finally { bitmap?.close(); }
    }
  }
  const purge = (store, rows) => {
    const now = Date.now();
    for (const row of rows) if (row.expiresAt <= now) store.delete(row.shareId);
    return rows.filter(row => row.expiresAt > now);
  };
  self.piImageIntakeStore = Object.freeze({
    validId, randomId, validate,
    async put({ file, ownerBinding = null, extraCount = 0 }) {
      await validate(file);
      const shareId = randomId(), createdAt = Date.now();
      return transaction('readwrite', (store, rows) => {
        rows = purge(store, rows);
        if (rows.length >= 3 || rows.reduce((n,r) => n + r.blob.size, 0) + file.size > 30 * 1024 ** 2) throw new Error('临时图片已满，请先保存或取消之前的分享');
        store.put({ shareId, blob: file, mime: file.type, createdAt, expiresAt: createdAt + TTL, state: 'stored', ownerBinding, extraCount, claim: null });
        return shareId;
      });
    },
    claim({ shareId, ownerBinding, claimant, confirmUnbound = false }) {
      return transaction('readwrite', (store, rows) => {
        if (!validId(shareId) || !ownerBinding || !claimant) throw new Error('分享入口无效');
        const row = purge(store, rows).find(r => r.shareId === shareId);
        if (!row) throw new Error('分享图片已失效，请重新分享或从相册上传');
        if (row.ownerBinding ? row.ownerBinding !== ownerBinding : !confirmUnbound) throw new Error('请确认导入此次分享，或使用原登录状态重新打开');
        if (row.claim && row.claim.claimant !== claimant && row.claim.until > Date.now()) throw new Error('此图片正在另一窗口编辑，请稍后重试');
        row.ownerBinding = ownerBinding; row.state = 'opened'; row.claim = { claimant, until: Date.now() + LEASE };
        store.put(row); return row;
      });
    },
    renew(shareId, claimant) {
      return transaction('readwrite', (store, rows) => {
        const row = rows.find(r => r.shareId === shareId);
        if (!row || row.expiresAt <= Date.now() || row.claim?.claimant !== claimant) throw new Error('分享草稿已失效');
        row.claim.until = Date.now() + LEASE; store.put(row);
      });
    },
    finish(shareId, claimant) {
      return transaction('readwrite', (store, rows) => {
        const row = rows.find(r => r.shareId === shareId);
        if (!row) return;
        if (row.claim?.claimant !== claimant) throw new Error('分享草稿属于另一窗口');
        store.delete(shareId);
      });
    },
    clearBinding(binding) {
      if (typeof binding !== 'string' || !binding) return Promise.resolve();
      return transaction('readwrite', (store, rows) => { for (const row of rows) if (row.ownerBinding === binding) store.delete(row.shareId); });
    },
    sweep() { return transaction('readwrite', (store, rows) => { purge(store, rows); }); }
  });
})();
