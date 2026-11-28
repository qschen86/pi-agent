/* 轻提示栈：所有「几秒后自己消失」的提示都进同一个栈，样式和位置与会话列表顶部的「已归档」条一致。
   多条同时出现时从上往下排：同文案只保留一条（刷新计时）；最多同时 3 条，再来新的就挤掉最早的；
   每条都有自己的 × 可单独关闭。「已归档」条在栈的上面，栈自动让到它下面。
   桌面端有会话列表栏时，栈锚定在列表栏内（宽度跟随列表），不横跨详情页；其余页面和手机端居中。 */
(function () {
  const MAX = 3;
  let stack = null;
  const ensure = () => {
    if (stack && stack.isConnected) return stack;
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    stack.id = 'toast-stack';
    document.body.append(stack);
    return stack;
  };
  /** 桌面端把栈对齐到会话列表栏、排在「已归档」条下面；没有列表栏 / 手机端时回到居中。 */
  function layout() {
    if (!stack || !stack.isConnected) return;
    const list = window.matchMedia('(min-width: 761px)').matches ? document.querySelector('.rt-list') : null;
    const box = list && list.getBoundingClientRect();
    if (!box || !box.width) { stack.classList.remove('in-list'); return; }
    const flash = list.querySelector('.rt-flash');
    stack.style.setProperty('--toast-left', Math.round(box.left + 8) + 'px');
    stack.style.setProperty('--toast-w', Math.round(box.width - 16) + 'px');
    // 用布局值而不是 getBoundingClientRect：条正在滑入时带 transform，量出来会偏
    stack.style.setProperty('--toast-top', Math.round(box.top + 8 + (flash ? list.clientTop + flash.offsetTop + flash.offsetHeight : 0)) + 'px');
    stack.classList.add('in-list');
  }
  window.addEventListener('resize', layout);
  const drop = (el) => { clearTimeout(el._toastTimer); el.remove(); if (stack && !stack.children.length) stack.remove(); };
  /** piToast(text, { tone: 'warn', ms: 4000, attrs: { 'data-x': '' } }) → 提示元素 */
  function piToast(text, options) {
    const opts = options || {};
    const root = ensure();
    const message = String(text);
    let el = [...root.children].find((child) => child.dataset.toastText === message);
    if (!el) {
      el = document.createElement('div');
      el.setAttribute('role', 'status');
      el.dataset.toastText = message;
      const body = document.createElement('span');
      body.className = 'toast-text';
      body.textContent = message;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'toast-x';
      close.setAttribute('aria-label', '关闭提示');
      close.textContent = '×';
      close.addEventListener('click', () => drop(el));
      el.append(body, close);
      root.append(el);
      while (root.children.length > MAX) drop(root.firstElementChild);
    }
    layout();
    el.className = 'pwa-updated-toast' + (opts.tone ? ' ' + opts.tone : '');
    for (const [key, value] of Object.entries(opts.attrs || {})) el.setAttribute(key, value);
    clearTimeout(el._toastTimer);
    el._toastTimer = setTimeout(() => drop(el), opts.ms || 4000);
    return el;
  }
  window.piToast = piToast;
  window.piToastLayout = layout;
})();
