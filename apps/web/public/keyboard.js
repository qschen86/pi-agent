/**
 * 手机软键盘：布局视口不会因为键盘而变小（Android Chrome / iOS Safari 都是这样），
 * 于是 100dvh 和 position: fixed; bottom: 0 的东西（底部浮层、一屏高的会话页）就藏在键盘后面。
 * 这里只做一件事：用 visualViewport 量出键盘挡住的高度写到 :root，交给样式自己收：
 *   --kb-inset  键盘挡住的高度，键盘收起时 0
 *   --kb-vh     现在真正看得见的高度
 *   --kb-page-h 一屏高的页面该有多高：可视高度 + 页面被顶上去的那一段（见下）
 * 地址栏收起也会让 visualViewport 变矮几十像素，那不是键盘：低于 MIN 一律当 0；捏合缩放
 * 也会让可视区变矮，看 visualViewport.scale，不是 1 时不认键盘。
 *
 * 预判：visualViewport 要等键盘动画开始后才变，而浏览器在聚焦的瞬间就把输入框滚进可视区。
 * 页面还是整屏高时，这一下滚动把输入框放到键盘上沿，底下带按钮的那一行被键盘盖住；
 * 随后真实的键盘高度到了页面才收短，输入框得再跳一次才能把那一行露出来。
 * 所以输入框一聚焦，就先按「这个屏幕上次量到的键盘高度」把页面收好（见 predict），
 * 真实数值到了再覆盖；超时仍没有键盘（外接键盘 / 不弹键盘的场景）就撤回。
 */
(() => {
  // 手机键盘最矮也有 200px 上下；地址栏 / 底部工具栏收起一次只有五六十像素
  const MIN = 120;
  const root = document.documentElement;
  let applied = "";
  let frame = 0;
  // 聚焦后等真实键盘多久，超过就认为这次不弹键盘并撤回预判
  const PREDICT_MS = 700;
  const STORE_KEY = "pi-kb-inset";
  let predicted = 0;
  let predictTimer = 0;
  const phone = window.matchMedia ? window.matchMedia("(max-width: 760px)") : { matches: false };

  // 键盘高度和机型、横竖屏、输入法有关：按屏幕尺寸分别记，读写都容错（隐私模式 / 配额）
  const sizeKey = () => `${window.innerWidth}x${window.innerHeight}`;
  function remembered() {
    try {
      const value = Number(JSON.parse(localStorage.getItem(STORE_KEY) || "{}")[sizeKey()]);
      return Number.isFinite(value) && value >= MIN && value < window.innerHeight * 0.8 ? Math.round(value) : 0;
    } catch { return 0; }
  }
  function remember(inset) {
    try {
      const all = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      if (all[sizeKey()] === inset) return;
      all[sizeKey()] = inset;
      localStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch { /* 记不住就只是少一次预判 */ }
  }
  // 会弹软键盘的输入元素；复选框、按钮之类聚焦不会弹键盘
  function typesText(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
    if (el instanceof HTMLInputElement) return !el.readOnly && !el.disabled && /^(text|search|url|tel|email|password|number|)$/i.test(el.type);
    return el.isContentEditable;
  }
  function endPredict() {
    clearTimeout(predictTimer);
    predictTimer = 0;
    if (!predicted) return;
    predicted = 0;
    applied = "";
    schedule();
  }

  function sync() {
    frame = 0;
    const vv = window.visualViewport;
    // 可视区底部到布局视口底部的距离就是键盘占掉的高度（页面被顶上去时也算进去）
    const covered = Math.round(window.innerHeight - (vv ? vv.height + vv.offsetTop : window.innerHeight));
    // 手机上的捏合缩放同样会让可视区变矮，但那是缩放不是键盘：看 scale
    const zoomed = !!vv && Math.abs((vv.scale || 1) - 1) > 0.05;
    let inset = !zoomed && covered >= MIN ? covered : 0;
    let visible = Math.round(vv ? vv.height : window.innerHeight);
    // iOS 弹键盘时会把可视区往上顶（offsetTop > 0）而不是缩短页面：页面从布局视口顶部排版，
    // 底部工具栏要比可视高度再多出被顶走的那一段，才刚好落在键盘上沿，而不是被裁在键盘上方。
    let pageHeight = Math.min(window.innerHeight, Math.round(vv ? vv.height + vv.offsetTop : window.innerHeight));
    if (inset) {
      remember(inset);
      // 真实键盘到了，预判到此为止
      clearTimeout(predictTimer);
      predictTimer = 0;
      predicted = 0;
    } else if (predicted && !zoomed) {
      // 键盘还在路上：保持预判，等真实数值覆盖或超时撤回
      inset = predicted;
      visible = window.innerHeight - predicted;
      pageHeight = visible;
    }
    // 没有键盘时只有 --kb-inset 一个值是有用的：--kb-vh / --kb-page-h 回到样式里的默认（100dvh，跟着窗口走）。
    // Android 原生壳弹键盘时是一帧一帧缩短 WebView，如果这里每帧都改根节点上的自定义属性，
    // 整页样式每帧重算、还要派发事件，动画就卡；没有键盘时状态恒定，一帧也不写。
    const state = inset ? `${inset}|${visible}|${pageHeight}` : "0";
    if (state === applied) return;
    applied = state;
    root.style.setProperty("--kb-inset", `${inset}px`);
    if (inset) {
      root.style.setProperty("--kb-vh", `${visible}px`);
      root.style.setProperty("--kb-page-h", `${pageHeight}px`);
    } else {
      root.style.removeProperty("--kb-vh");
      root.style.removeProperty("--kb-page-h");
    }
    root.classList.toggle("kb-open", inset > 0);
    // 页面按新的可视高度收缩后要重新贴底的地方（如新建页的输入区）听这个事件
    document.dispatchEvent(new CustomEvent("pi-keyboard", { detail: { inset, visible, pageHeight } }));
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(sync);
  }

  // 输入框聚焦：键盘还没出现，先按记住的高度把页面收好
  function predict(target) {
    if (!phone.matches || !typesText(target)) return;
    // 程序自己聚焦（页面加载时的 autofocus）不是点出来的，iOS 不会弹键盘，别猜
    if (navigator.userActivation && !navigator.userActivation.isActive) return;
    const vv = window.visualViewport;
    // 已经有键盘 / 正在缩放：量到的数就是真的，不用猜
    if (root.classList.contains("kb-open") && !predicted) return;
    if (vv && Math.abs((vv.scale || 1) - 1) > 0.05) return;
    const inset = remembered();
    if (!inset) return;
    predicted = inset;
    applied = "";
    sync();
    clearTimeout(predictTimer);
    predictTimer = setTimeout(endPredict, PREDICT_MS);
  }

  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
  }
  window.addEventListener("resize", schedule);
  window.addEventListener("orientationchange", schedule);
  // 有的 WebView 弹键盘只改可视区、不派发 resize：焦点变化后再量一次
  window.addEventListener("focusin", (event) => {
    schedule();
    predict(event.target);
  });
  window.addEventListener("focusout", () => {
    // 焦点只是在输入框之间切换时，紧接着的 focusin 会重新预判；这里先不动，下一拍再看
    setTimeout(() => {
      if (!typesText(document.activeElement)) endPredict();
      schedule();
    }, 0);
  });
  window.addEventListener("pageshow", schedule);
  sync();
})();
