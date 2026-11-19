/* 股票账户记账：一级导航「股票」。
 *
 * 页面只做展示与录入，占比永远由服务端按「股东权益 / 账户市值」算出来。
 * 每次动账都带「动账前 / 动账后」两份快照，所以股票涨跌、入金出金、股东间转让
 * 都能回看到当时每个股东的占比，而不是只看到现在的数字。
 */
(() => {
  const KIND_LABEL = { deposit: "入金", withdraw: "出金", transfer: "股东间转让", revalue: "市值更新" };
  // 负债账户是同一套账本的反面：deposit = 又借了（余额增加），withdraw = 还款（余额减少）。
  const LIABILITY_KIND_LABEL = { deposit: "借款", withdraw: "还款", transfer: "债权转让", revalue: "余额调整" };
  const KIND_HINT = {
    deposit: "股东把钱投进账户；动账后市值默认按当前市值 + 入金，股票涨跌后请填实际市值。",
    withdraw: "股东从账户取钱；动账后市值默认按当前市值 - 出金，股票涨跌后请填实际市值。",
    transfer: "钱只在股东之间转，账户市值不变；股票涨跌请另记一笔「市值更新」。",
    revalue: "只更新账户市值（例如股票涨跌），各股东按原占比分摊，占比不变。"
  };
  const LIABILITY_KIND_HINT = {
    deposit: "又向债权人借了钱；动账后余额默认按「当前余额 + 借款」，利息或手续费另记「余额调整」。",
    withdraw: "向债权人还款；动账后余额默认按「当前余额 - 还款」。",
    transfer: "债权只在债权人之间转，负债总额不变；只调整总额用「余额调整」。",
    revalue: "只更新未还余额（例如利息、抹零），各债权人按原占比分摊，占比不变。"
  };
  const accountIsLiability = (account) => !!account && account.kind === "liability";
  const kindLabel = (kind, account) => (accountIsLiability(account) ? LIABILITY_KIND_LABEL : KIND_LABEL)[kind] || kind;
  const kindHint = (kind, account) => (accountIsLiability(account) ? LIABILITY_KIND_HINT : KIND_HINT)[kind] || "";
  const NEW_SHAREHOLDER = "__new__";
  /**
   * 明细合并成一张表以后按「账户 + 类型」筛：类型是资产 / 负债账户通用的说法，
   * deposit = 入金 / 借款，withdraw = 出金 / 还款。
   */
  const HISTORY_KIND_FILTERS = [
    { id: "all", label: "全部类型", kinds: null },
    { id: "in", label: "入金 / 借款", kinds: ["deposit"] },
    { id: "out", label: "出金 / 还款", kinds: ["withdraw"] },
    { id: "transfer", label: "转让", kinds: ["transfer"] },
    { id: "revalue", label: "市值 / 余额调整", kinds: ["revalue"] }
  ];
  /** 时间筛选：按动账发生的时间往前推，days 为 null 表示不限；year 表示今年 1 月 1 日起。 */
  const HISTORY_TIME_FILTERS = [
    { id: "all", label: "全部时间", days: null },
    { id: "7d", label: "近 7 天", days: 7 },
    { id: "30d", label: "近 30 天", days: 30 },
    { id: "90d", label: "近 90 天", days: 90 },
    { id: "year", label: "今年", year: true }
  ];
  /** 账单一次显示这么多笔，滚到底自动再加载下一页。 */
  const HISTORY_PAGE_SIZE = 20;
  /**
   * 金额默认藏起来（页面可能对着别人看）。眼睛按钮切换，状态存在 localStorage，
   * 下次打开还是上次的样子；只藏总金额和分项金额，占比、姓名、时间、备注照常显示。
   */
  const AMOUNTS_KEY = "pi-ledger-amounts";
  // 界面金额统一用「万」、保留 1 位小数（1 位 = 1000 元）；眼睛闭着时只留占位符。
  const MASK = "•••• 万";
  /* 记账助手：默认 DeepSeek Flash + 高推理；模型选择与对话记录存在本机，刷新页面还接着聊。 */
  const CHAT_STORAGE_KEY = "pi-ledger-chat";
  const CHAT_DEFAULT_MODEL = "deepseek/deepseek-flash";
  const CHAT_DEFAULT_THINKING = "high";
  const CHAT_MAX_MESSAGES = 24;
  const CHAT_HISTORY_FOR_MODEL = 16;
  const THINKING_LABEL = { off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
  const CHAT_MODEL_FALLBACK = [{ ref: CHAT_DEFAULT_MODEL, displayName: "DeepSeek V4.1 Flash", thinkingLevels: ["off", "low", "high", "max"] }];
  // 睁眼 / 闭眼两个图标：与导航同一套 24px 描边风格，闭眼多一条斜线
  const EYE_ON_PATHS = [
    "M2.06 12.35a1 1 0 0 1 0-.7C3.3 8.5 6.9 5.5 12 5.5s8.7 3 9.94 6.15a1 1 0 0 1 0 .7C20.7 15.5 17.1 18.5 12 18.5S3.3 15.5 2.06 12.35Z",
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"
  ];
  const EYE_OFF_PATHS = [...EYE_ON_PATHS, "M4 4l16 16"];
  let amountsHidden = true;
  try {
    const saved = localStorage.getItem(AMOUNTS_KEY);
    if (saved === "shown" || saved === "hidden") amountsHidden = saved === "hidden";
  } catch { /* 隐私模式下只在本页生效 */ }
  const L = {
    open: null,
    form: null,
    edit: null,
    create: null,
    busy: "",
    error: "",
    message: "",
    txOpen: new Set(),
    // 动账明细的筛选：账户（"all" 或账户 id）、类型（"all" 或 in/out/transfer/revalue）、时间（见 HISTORY_TIME_FILTERS）；limit 是已展示的笔数（分页）
    history: { account: "all", kind: "all", time: "all", limit: HISTORY_PAGE_SIZE, observer: null, menu: null },
    // 记账助手：对话记录、模型选择和「还没确认结果」的那次请求都放在这里，
    // 页面每次重绘（眼睛开关、刷新动账）都不会把正在说的话弄丢。
    chat: {
      messages: [],
      draft: "",
      busy: false,
      error: "",
      info: null,
      infoLoading: false,
      infoFailed: false,
      model: CHAT_DEFAULT_MODEL,
      thinking: CHAT_DEFAULT_THINKING,
      pending: null,
      scrollBottom: true,
      // 手机上对话默认收成一个底部输入框：点「记录」才把对话记录展开，发完消息自动展开一次
      mobileOpen: false,
      // 模型 / 强度折叠状态：放这里才不会被每次重绘（动账后刷新）自己关上
      configOpen: false
    }
  };
  loadChatState();

  /** 元 → 「万」：界面只展示 1 位小数，输入与账本仍按元 / 分记录。 */
  const fmtMoney = (value) => {
    const n = Number(value);
    return `${(Number.isFinite(n) ? n / 10000 : 0).toFixed(1)} 万`;
  };
  /** 页面上展示金额统一走这里：眼睛闭着时换成占位符，不泄露任何数字。 */
  const fmtAmount = (value) => (amountsHidden ? MASK : fmtMoney(value));
  const pct = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    if (n > 0 && n < 0.01) return "<0.01%";
    return n.toFixed(2) + "%";
  };
  /** 一次表单提交一个键：网络超时后用户再点保存，服务端能认出是同一笔，不会重复记账。 */
  const newIdempotencyKey = () => (window.crypto && typeof window.crypto.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `ledger-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const fmtTime = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso || "");
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const accountList = () => (ui.ledger && Array.isArray(ui.ledger.accounts) ? ui.ledger.accounts : []);
  const txList = () => (ui.ledger && Array.isArray(ui.ledger.transactions) ? ui.ledger.transactions : []);
  const accountById = (id) => accountList().find((account) => account.id === id) || null;
  const txFor = (accountId) => txList().filter((tx) => tx.accountId === accountId);
  const shareholderById = (account, id) => (account.shareholders || []).find((s) => s.shareholderId === id) || null;

  function setAmountsHidden(hidden) {
    amountsHidden = hidden;
    try { localStorage.setItem(AMOUNTS_KEY, hidden ? "hidden" : "shown"); } catch { /* 存储不可用时只在本页生效 */ }
    renderMain();
  }

  function renderAmountToggle() {
    const label = amountsHidden ? "显示金额" : "隐藏金额";
    return h("button", {
      class: "ledger-eye", type: "button", "aria-pressed": String(amountsHidden), "aria-label": label, title: label,
      onclick: () => setAmountsHidden(!amountsHidden)
    }, eyeIcon(amountsHidden ? EYE_OFF_PATHS : EYE_ON_PATHS));
  }

  /** 小图标：runtime.js 在时用它的图标工具，单独跑页面（测试）时现画一个同样尺寸的。 */
  function iconSvg(paths, { className = "ledger-icon", size = 15 } = {}) {
    if (typeof rtMiniIcon === "function") return rtMiniIcon(paths, { className, size });
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", width: String(size), height: String(size), fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: className })) svg.setAttribute(key, value);
    for (const d of paths) { const path = document.createElementNS(ns, "path"); path.setAttribute("d", d); svg.append(path); }
    return svg;
  }
  const eyeIcon = (paths) => iconSvg(paths, { className: "ledger-eye-icon", size: 15 });

  function setMessage(text, error = false) {
    L.message = error ? "" : text;
    L.error = error ? text : "";
  }

  async function reloadLedger() {
    invalidateReads((key) => key === "/api/ledger");
    await refresh({ main: true, force: true });
  }

  async function runWrite(work) {
    if (L.busy) return;
    L.busy = "正在保存…";
    L.error = ""; L.message = "";
    renderMain();
    try {
      const message = await work();
      if (message) L.message = message;
      await reloadLedger();
    } catch (error) {
      L.error = error?.message || "保存失败，请重试";
    } finally {
      L.busy = "";
      renderMain();
    }
  }

  /* ----------------------------- 记账助手 ----------------------------- */

  function loadChatState() {
    try {
      const saved = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || "null");
      if (!saved || typeof saved !== "object") return;
      if (Array.isArray(saved.messages)) {
        L.chat.messages = saved.messages
          .filter((message) => message && (message.role === "user" || message.role === "assistant") && typeof message.text === "string")
          .slice(-CHAT_MAX_MESSAGES)
          .map((message) => ({
            role: message.role,
            text: String(message.text).slice(0, 1000),
            actions: Array.isArray(message.actions) ? message.actions.slice(0, 5) : []
          }));
      }
      if (typeof saved.model === "string" && saved.model) L.chat.model = saved.model;
      if (typeof saved.thinking === "string" && saved.thinking) L.chat.thinking = saved.thinking;
      if (saved.pending && typeof saved.pending === "object" && typeof saved.pending.requestId === "string") {
        L.chat.pending = saved.pending;
        L.chat.error = typeof saved.error === "string" && saved.error
          ? saved.error
          : "上一次请求没有收到结果：先刷新核对账户，再点重试（同一个请求只会记一次）。";
      }
    } catch { /* 本地存储不可用时就只在本次打开里对话 */ }
  }

  function saveChat() {
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({
        messages: L.chat.messages.slice(-CHAT_MAX_MESSAGES),
        model: L.chat.model,
        thinking: L.chat.thinking,
        pending: L.chat.pending,
        error: L.chat.pending ? L.chat.error : ""
      }));
    } catch { /* 存不下不影响对话本身 */ }
  }

  function thinkingLabel(level) {
    return THINKING_LABEL[level] || level || "默认";
  }

  /** 服务端模型目录只读一次：拿到默认模型与每档可选强度，页面不自己猜。 */
  function ensureChatInfo() {
    if (L.chat.info || L.chat.infoLoading || L.chat.infoFailed) return;
    L.chat.infoLoading = true;
    api("/api/ledger/chat").then((info) => {
      L.chat.info = info && typeof info === "object" ? info : { available: false, models: [] };
      adoptChatDefaults();
    }).catch(() => {
      // 读不到目录就按内置默认值用，不反复重试；发送时服务端仍会校验。
      L.chat.infoFailed = true;
    }).finally(() => {
      L.chat.infoLoading = false;
      renderMain();
    });
  }

  function adoptChatDefaults() {
    const info = L.chat.info;
    const models = info && Array.isArray(info.models) ? info.models : [];
    if (!models.length) return;
    const refs = models.map((model) => model.ref);
    if (!refs.includes(L.chat.model) && typeof info.defaultModel === "string" && refs.includes(info.defaultModel)) {
      L.chat.model = info.defaultModel;
    }
    const current = models.find((model) => model.ref === L.chat.model) || models[0];
    const levels = current && Array.isArray(current.thinkingLevels) ? current.thinkingLevels : [];
    if (levels.length && !levels.includes(L.chat.thinking)) {
      L.chat.thinking = levels.includes(CHAT_DEFAULT_THINKING) ? CHAT_DEFAULT_THINKING : levels[levels.length - 1];
    }
    saveChat();
  }

  function chatModels() {
    const models = L.chat.info && Array.isArray(L.chat.info.models) ? L.chat.info.models : [];
    return models.length ? models : CHAT_MODEL_FALLBACK;
  }

  function chatModel() {
    const models = chatModels();
    return models.find((model) => model.ref === L.chat.model) || models[0];
  }

  function setChatModel(ref) {
    L.chat.model = ref;
    const model = chatModels().find((item) => item.ref === ref);
    const levels = model && Array.isArray(model.thinkingLevels) ? model.thinkingLevels : [];
    if (levels.length && !levels.includes(L.chat.thinking)) {
      L.chat.thinking = levels.includes(CHAT_DEFAULT_THINKING) ? CHAT_DEFAULT_THINKING : levels[levels.length - 1];
    }
    saveChat();
    renderMain();
  }

  function setChatThinking(level) {
    L.chat.thinking = level;
    saveChat();
    renderMain();
  }

  function chatUnavailable() {
    return !!L.chat.info && L.chat.info.available === false;
  }

  /** 手机上右下角「＋」打开记账对话、对话里的「收起」关掉它：对话本身不丢，草稿也留着。 */
  function toggleChatLog() {
    L.chat.mobileOpen = !L.chat.mobileOpen;
    if (L.chat.mobileOpen) { L.chat.scrollBottom = true; L.chat.entering = true; }
    renderMain();
    // 点「＋」是用户手势，直接聚焦输入框，手机上键盘跟着弹出来
    if (L.chat.mobileOpen) {
      const input = document.getElementById("ledger-chat-input");
      if (input && !input.disabled) input.focus({ preventScroll: true });
    }
  }

  /** 只收起（不切换）：系统返回 / 遮罩 / 下滑 / ✕ 都走这里。对话和草稿都留着。 */
  function closeChatLog() {
    if (!L.chat.mobileOpen) return;
    L.chat.mobileOpen = false;
    renderMain();
  }

  /** 标题栏（顶部有一条抓手）往下拖：跟手位移，拖过一段或甩得够快就收起，否则弹回。 */
  function startSheetDrag(event) {
    if (event.button > 0 || event.target.closest("button")) return;
    const bar = event.currentTarget;
    const sheet = bar.closest(".ledger-chat");
    if (!sheet || !window.matchMedia("(max-width: 760px)").matches) return;
    const startY = event.clientY, startAt = performance.now(), id = event.pointerId;
    let dy = 0;
    try { bar.setPointerCapture(id); } catch { /* 不支持就靠冒泡 */ }
    sheet.style.transition = "none";
    const move = (e) => {
      if (e.pointerId !== id) return;
      dy = Math.max(0, e.clientY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    };
    const end = (e) => {
      if (e.pointerId !== id) return;
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", end);
      bar.removeEventListener("pointercancel", end);
      const fast = dy > 24 && dy / Math.max(1, performance.now() - startAt) > 0.6;
      sheet.style.transition = "";
      sheet.style.transform = "";
      if (e.type !== "pointercancel" && (dy > Math.min(120, sheet.offsetHeight * 0.3) || fast)) closeChatLog();
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", end);
    bar.addEventListener("pointercancel", end);
  }

  function renderChatPanel() {
    ensureChatInfo();
    const model = chatModel();
    const levels = model && Array.isArray(model.thinkingLevels) && model.thinkingLevels.length ? model.thinkingLevels : ["high"];
    // 输入框只在发送中 / 没模型时锁住；结果没确认时仍可打字，但发不出去。
    const disabled = L.chat.busy || chatUnavailable();
    const sendDisabled = disabled || !!L.chat.pending;
    const log = h("div", {
      class: "ledger-chat-log", id: "ledger-chat-log", "data-keep-scroll": "ledger-chat",
      role: "log", "aria-label": "和记账助手的对话"
    }, L.chat.messages.length ? L.chat.messages.map(renderChatMessage) : renderChatEmpty());
    if (L.chat.scrollBottom) {
      // renderMain 会先恢复旧滚动位置，这个微任务在它之后跑，保证新消息在视野里。
      L.chat.scrollBottom = false;
      queueMicrotask(() => {
        const el = document.getElementById("ledger-chat-log");
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
    // 手机上对话默认不占屏幕，只留右下角圆形「＋」（和待办页的新建同一个样子、同一个位置）；
    // 桌面 / 平板隐藏它，对话一直展开
    const fab = h("button", {
      type: "button", id: "ledger-chat-fab", class: "btn primary ledger-chat-fab",
      "aria-label": "记一笔（对话记账）", title: "记一笔（对话记账）",
      "aria-expanded": String(!!L.chat.mobileOpen),
      onclick: toggleChatLog
    }, h("span", { "aria-hidden": "true" }, "＋"));
    // 手机上浮层的遮罩：压暗底层页面，点它收起；桌面不显示
    // 升起动画只在刚打开时播一次：之后每次重绘（发消息、切配置）浮层原地不动
    const entering = !!(L.chat.mobileOpen && L.chat.entering);
    L.chat.entering = false;
    const scrim = h("div", {
      class: "ledger-chat-scrim" + (L.chat.mobileOpen ? " is-open" : "") + (entering ? " is-entering" : ""), "aria-hidden": "true",
      onclick: closeChatLog
    });
    return [scrim, h("aside", {
      class: "ledger-chat" + (L.chat.mobileOpen ? " is-open" : "") + (entering ? " is-entering" : ""), "aria-label": "记账助手",
      onkeydown: (event) => { if (event.key === "Escape" && L.chat.mobileOpen) closeChatLog(); }
    },
      // 标题栏：手机上是浮层的把手（可下拉收起），关闭键在右上角，不再塞进输入框
      h("div", { class: "ledger-chat-head", onpointerdown: startSheetDrag },
        h("h2", { class: "ledger-chat-title" }, "记账助手"),
        h("button", {
          class: "btn ghost small", type: "button", disabled: !L.chat.messages.length || L.chat.busy,
          onclick: clearChat
        }, "清空"),
        h("button", {
          class: "ledger-chat-close", type: "button", "aria-label": "收起记账对话", title: "收起记账对话",
          onclick: closeChatLog
        }, h("span", { "aria-hidden": "true" }, "✕"))),
      // 模型 / 强度是偶尔改一次的配置：平时只占摘要一行，点开才露出两个下拉
      h("details", { class: "ledger-chat-config", open: L.chat.configOpen ? "" : undefined },
        h("summary", {
          class: "ledger-chat-config-summary",
          // 点标题自己翻状态（不用 details 的原生 toggle）：状态存在 L 里，重绘后仍然是展开的
          onclick: (event) => { event.preventDefault(); L.chat.configOpen = !L.chat.configOpen; renderMain(); }
        }, h("span", { class: "ledger-chat-model muted small" }, `${model.displayName || model.ref} · ${thinkingLabel(L.chat.thinking)}推理`)),
        h("div", { class: "ledger-chat-selects" },
          h("select", {
            class: "ledger-chat-select", "aria-label": "模型", value: L.chat.model, disabled: L.chat.busy,
            onchange: (event) => setChatModel(event.target.value)
          }, chatModels().map((item) => h("option", { value: item.ref, selected: item.ref === L.chat.model }, item.displayName || item.ref))),
          h("select", {
            class: "ledger-chat-select", "aria-label": "推理强度", value: L.chat.thinking, disabled: L.chat.busy,
            onchange: (event) => setChatThinking(event.target.value)
          }, levels.map((level) => h("option", { value: level, selected: level === L.chat.thinking }, `强度：${thinkingLabel(level)}`))))),
      chatUnavailable()
        ? h("p", { class: "muted small ledger-chat-unavailable", role: "status" }, "记账助手没有配置模型，暂时不能对话；页面里的手动动账照常可用。")
        : null,
      log,
      L.chat.error
        ? h("div", { class: "ledger-chat-error", role: "alert" },
          h("p", { class: "field-error small" }, L.chat.error),
          L.chat.pending && !L.chat.busy
            ? h("div", { class: "ledger-chat-error-actions" },
              h("button", { class: "btn small", type: "button", onclick: retryChat }, "重试这次请求（不会重复记账）"),
              h("button", { class: "btn ghost small", type: "button", onclick: dismissPending }, "放弃这次（先核对账户）"))
            : null)
        : null,
      h("form", { class: "ledger-chat-compose", onsubmit: sendChat },
        h("label", { class: "sr-only", for: "ledger-chat-input" }, "给记账助手发消息"),
        h("textarea", {
          id: "ledger-chat-input", "data-key": "ledger-chat-input", rows: "1", maxlength: "1000",
          placeholder: "说一句话记账…", value: L.chat.draft, disabled,
          onfocus: (event) => resizeChatInput(event.target),
          onblur: (event) => { event.target.style.height = ""; event.target.style.overflowY = ""; },
          oninput: (event) => { L.chat.draft = event.target.value; resizeChatInput(event.target); },
          onkeydown: (event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
              event.preventDefault();
              sendChat(event);
            }
          }
        }),
        // 发送键放在输入框里面（同一个圆角框），跟会话语输入区一致
        h("div", { class: "ledger-chat-actions" },
          h("span", { class: "muted small ledger-chat-compose-hint" }, L.chat.busy
            ? "助手正在读取账户…"
            : L.chat.pending ? "先处理上面那次没确认的请求" : "Enter 发送 · Shift+Enter 换行"),
          h("span", { class: "ledger-spacer" }),
          h("button", { class: "btn primary small ledger-chat-send", type: "submit", disabled: sendDisabled || !String(L.chat.draft || "").trim() },
            L.chat.busy ? "发送中…" : "发送")))), fab];
  }

  // 与详情页一致：聚焦时按内容增长，超出上限滚动；失焦恢复 CSS 的单行高度。
  function resizeChatInput(input) {
    const style = getComputedStyle(input);
    const limit = parseFloat(style.maxHeight);
    input.style.height = "0px";
    input.style.overflowY = "hidden";
    const height = Math.min(Math.max(parseFloat(style.minHeight), input.scrollHeight), limit);
    input.style.height = `${height}px`;
    input.style.overflowY = input.scrollHeight > height + 1 ? "auto" : "hidden";
  }

  function renderChatEmpty() {
    // 示例优先用真实账户和股东：点了就发也不会因为「找不到账户」白跑一趟。
    const account = accountList()[0];
    const people = (account && Array.isArray(account.shareholders) ? account.shareholders : []).map((s) => s.name);
    const examples = account && people.length
      ? [
        `${people[0]}往「${account.name}」入金 10 万`,
        `「${account.name}」现在每个股东占多少`,
        `「${account.name}」市值涨到 150 万`,
        ...(people.length > 1 ? [`把 ${people[0]} 的 20 万转给 ${people[1]}`] : [])
      ]
      : ["小明往富途账户入金 10 万", "东方财富账户股票涨到 130 万", "把小红的 20 万转给小明"];
    const debt = accountList().find(accountIsLiability);
    if (debt && debt.shareholders[0]) examples.push(`向 ${debt.shareholders[0].name} 还款 1 万`);
    return h("div", { class: "ledger-chat-empty" },
      h("p", {}, "用说话的方式记账或问账户情况，记完会列出每个股东 / 债权人的前后占比。"),
      h("div", { class: "ledger-chat-examples" },
        examples.map((example) => h("button", {
          class: "ledger-chat-example", type: "button",
          onclick: () => { L.chat.draft = example; renderMain(); }
        }, example))),
      h("p", { class: "muted small" }, "只记你明确要求的动账；账户或股东 / 债权人对不上时会先问你，不会猜。"));
  }

  function renderChatMessage(message) {
    const actions = Array.isArray(message.actions) ? message.actions : [];
    return h("div", { class: "ledger-chat-msg is-" + message.role },
      h("div", { class: "ledger-chat-role" }, message.role === "user" ? "我" : "助手"),
      message.text ? h("div", { class: "ledger-chat-text" }, message.text) : null,
      actions.map(renderChatAction));
  }

  function renderChatAction(result) {
    if (!result || typeof result !== "object") return null;
    const liability = result.accountKind === "liability";
    if (!result.ok) {
      return h("div", { class: "ledger-chat-result is-error" },
        h("div", { class: "ledger-chat-result-head" },
          h("span", { class: "ledger-kind" }, "没记上"),
          h("strong", {}, result.error || "这条动账没有写入")),
        h("p", { class: "muted small" }, "这条没有写入；同一轮里前面已经成功的动账不受影响。账户或金额改清楚后再说一次就行。"));
    }
    const labels = liability ? LIABILITY_KIND_LABEL : KIND_LABEL;
    const label = result.kind === "create" ? (liability ? "新建负债" : "新建")
      : result.kind === "undo" ? "撤销"
        : labels[result.kind] || result.kind;
    const head = result.kind === "create" ? `已创建${liability ? "负债" : ""}账户「${result.accountName}」`
      : result.kind === "undo" ? `已撤销「${result.accountName}」最近一笔${result.undoneKind ? `（${labels[result.undoneKind] || result.undoneKind}）` : ""}`
        : result.kind === "transfer" ? `已记入「${result.accountName}」：${result.shareholderName || "—"} → ${result.counterpartyName || "—"} ${liability ? "债权转让" : "转让"} ${fmtAmount(result.amount)}`
          : result.kind === "revalue" ? `已记入「${result.accountName}」：${liability ? "余额调整" : "市值更新"}`
            : liability
              ? `已记入「${result.accountName}」：向 ${result.shareholderName || "—"} ${result.kind === "deposit" ? "借款" : "还款"} ${fmtAmount(result.amount)}`
              : `已记入「${result.accountName}」：${result.shareholderName || "—"} ${KIND_LABEL[result.kind] || ""} ${fmtAmount(result.amount)}`;
    const kindClass = result.kind === "create" || result.kind === "undo" ? "transfer" : result.kind;
    return h("div", { class: "ledger-chat-result" + (result.duplicate ? " is-duplicate" : "") },
      h("div", { class: "ledger-chat-result-head" },
        h("span", { class: "ledger-kind ledger-kind-" + kindClass }, label),
        h("strong", {}, head),
        result.duplicate ? h("span", { class: "badge accent" }, "已经记过") : null),
      result.marketValueBefore !== undefined && result.marketValueAfter !== undefined
        ? h("div", { class: "ledger-chat-mv muted small" }, liability ? "余额 " : "市值 ", h("span", { class: "ledger-amount" }, fmtAmount(result.marketValueBefore)), " → ", h("strong", { class: "ledger-amount" }, fmtAmount(result.marketValueAfter)))
        : null,
      Array.isArray(result.after) && result.after.length
        ? h("div", { class: "ledger-ratio-change" }, result.after.map((row) => {
          const before = (Array.isArray(result.before) ? result.before : []).find((item) => item.shareholderId === row.shareholderId);
          const changed = !before || Math.abs(Number(before.percent) - Number(row.percent)) > 0.00005;
          if (result.kind === "create" || !before) {
            return h("span", { class: "ledger-ratio-chip changed" },
              h("span", { class: "ledger-ratio-name" }, row.name), " ", h("strong", {}, pct(row.percent)));
          }
          return h("span", { class: "ledger-ratio-chip" + (changed ? " changed" : "") },
            h("span", { class: "ledger-ratio-name" }, row.name), " ",
            pct(before.percent), " → ", h("strong", {}, pct(row.percent)));
        }))
        : null,
      result.kind === "create" && Array.isArray(result.after)
        ? h("p", { class: "muted small ledger-chat-hint" }, liability
          ? "初始占比已按余额分到每个债权人的债权；以后用「借款 / 还款」继续记账。"
          : "初始占比已按市值分到每个股东的权益；以后用入金 / 出金 / 转让继续记账。")
        : null,
      result.note ? h("p", { class: "muted small ledger-chat-hint" }, result.note) : null);
  }

  /** 把上一笔的执行结果也告诉模型：它才知道「刚才那笔」是哪一笔。 */
  function chatHistoryForModel() {
    return L.chat.messages.slice(-CHAT_HISTORY_FOR_MODEL).map((message) => {
      const outcomes = (Array.isArray(message.actions) ? message.actions : [])
        .map((action) => action && (action.ok ? action.summary : `没记上：${action.error || ""}`))
        .filter(Boolean);
      return {
        role: message.role,
        text: [message.text, outcomes.length ? `（执行结果：${outcomes.join("；")}）` : ""].filter(Boolean).join("\n").slice(0, 1000)
      };
    });
  }

  function sendChat(event) {
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    if (L.chat.busy) return;
    // 上一次请求还没确认就不要叠一条新的：那笔可能已经写进去了，先重试（幂等）或先核对。
    if (L.chat.pending) return;
    const text = String(L.chat.draft || "").trim();
    if (!text) return;
    if (text.length > 1000) { L.chat.error = "一条消息最多 1000 个字"; renderMain(); return; }
    L.chat.messages.push({ role: "user", text, actions: [] });
    L.chat.messages = L.chat.messages.slice(-CHAT_MAX_MESSAGES);
    L.chat.draft = "";
    L.chat.error = "";
    L.chat.pending = null;
    const payload = {
      requestId: newIdempotencyKey(),
      accountId: L.open || undefined,
      model: L.chat.model,
      thinking: L.chat.thinking,
      messages: chatHistoryForModel()
    };
    saveChat();
    void dispatchChat(payload);
  }

  function retryChat() {
    if (!L.chat.pending || L.chat.busy) return;
    void dispatchChat(L.chat.pending);
  }

  /** 放弃一次结果未知的请求：只在用户确认已经核对过账户后才清掉重试入口。 */
  function dismissPending() {
    if (!L.chat.pending || L.chat.busy) return;
    if (!window.confirm("先到账户卡片上核对一下有没有记进去；确认之后才清掉这次重试入口。确定放弃这次请求？")) return;
    L.chat.pending = null;
    L.chat.error = "";
    saveChat();
    renderMain();
  }

  async function dispatchChat(payload) {
    if (L.chat.busy) return;
    L.chat.busy = true;
    L.chat.error = "";
    L.chat.scrollBottom = true;
    renderMain();
    try {
      const result = await postChat(payload);
      const actions = result && Array.isArray(result.actions) ? result.actions.slice(0, 5) : [];
      L.chat.messages.push({
        role: "assistant",
        text: result && typeof result.reply === "string" ? result.reply : "",
        actions
      });
      L.chat.messages = L.chat.messages.slice(-CHAT_MAX_MESSAGES);
      if (result && result.ledger) {
        ui.ledger = result.ledger;
        invalidateReads((key) => key === "/api/ledger");
      }
      // 动账成功后账户卡片上的提示与助手结果不重复：结果就在对话里。
      L.message = ""; L.error = "";
      L.chat.pending = null;
      // 手机上的对话默认收着，有结果了就展开，占比变化在视野里
      L.chat.mobileOpen = true;
    } catch (error) {
      L.chat.error = (error && error.message) || "没有记上，请刷新页面核对账户后再试";
      // 出错时也要把提示露出来，不然收着的对话框只闪一下
      L.chat.mobileOpen = true;
      // 保留同一个 requestId：再点一次「重试」服务端只会写一次。
      L.chat.pending = payload;
    } finally {
      L.chat.busy = false;
      saveChat();
      renderMain();
    }
  }

  /** 网络层不确定时（超时、502/504、断线）用同一个 requestId 再试一次；服务端按 requestId 去重。 */
  async function postChat(payload) {
    const body = JSON.stringify(payload);
    try {
      return await api("/api/ledger/chat", { method: "POST", body });
    } catch (error) {
      const status = Number(error && error.status) || 0;
      if (status && status !== 408 && status !== 502 && status !== 504) throw error;
      await new Promise((resolve) => setTimeout(resolve, 800));
      return api("/api/ledger/chat", { method: "POST", body });
    }
  }

  function clearChat() {
    if (L.chat.busy || !L.chat.messages.length) return;
    if (!window.confirm("清空和记账助手的对话记录？账户数据不受影响。")) return;
    L.chat.messages = [];
    L.chat.pending = null;
    L.chat.error = "";
    L.chat.scrollBottom = true;
    saveChat();
    renderMain();
  }

  /* ------------------------------- 页面 ------------------------------- */

  function renderLedger() {
    const data = ui.ledger;
    const accounts = accountList();
    const summary = data?.summary || {};
    const liabilityAccounts = accounts.filter(accountIsLiability);
    const assetAccounts = accounts.filter((account) => !accountIsLiability(account));
    const hasLiabilities = liabilityAccounts.length > 0;
    // 账户并排一行、可左右横滑：资产账户在前，负债账户排在后面（卡片自带「负债」标记）
    const cards = h("div", { class: "ledger-cards", role: "list", "aria-label": "账户" },
      [...assetAccounts, ...liabilityAccounts].map((account) => h("div", { class: "ledger-cards-item", role: "listitem" }, renderAccount(account))));
    const accountSection = data
      ? (accounts.length ? [cards, renderAccountForm()] : h("div", { class: "card ledger-empty" },
        h("p", {}, "还没有股票账户。"),
        h("p", { class: "muted small" }, "先建一个账户，填当前市值和股东占比；以后每次入金、出金、股东间转让或市值变化都记一笔动账，就能看到前后占比。")))
      : h("div", { class: "card ledger-empty" }, h("p", { role: "status" }, "正在读取股票账户…"));
    return h("section", { class: "ledger-page" },
      h("div", { class: "ledger-shell" },
        h("div", { class: "ledger-body" },
          h("div", { class: "ledger-head" },
            h("div", { class: "ledger-head-text" },
              h("h1", {}, "股票账户"),
              h("p", { class: "muted ledger-sub" }, "市值与占比 · 单位：万")),
            // 新建账户不常做：右上角一个淡入口，把首屏留给账户本身
            h("button", {
              class: "btn ghost small ledger-new-account", type: "button",
              title: L.create ? "取消新建账户" : "新建账户",
              "aria-label": L.create ? "取消新建账户" : "新建账户",
              onclick: () => { L.create = L.create ? null : newCreateDraft(); L.error = ""; renderMain(); }
            }, h("span", { class: "ledger-new-account-plus", "aria-hidden": "true" }, "＋"),
            h("span", { class: "ledger-new-account-label-full" }, L.create ? "取消新建" : "新建账户"),
            h("span", { class: "ledger-new-account-label-short" }, L.create ? "取消" : "新建"))),
          h("div", { class: "ledger-summary" },
            h("span", {}, "账户 ", h("strong", {}, String(summary.accountCount ?? accounts.length))),
            h("span", { class: "ledger-total-amount" }, "资产合计 ",
              h("strong", { class: "ledger-amount" }, fmtAmount(summary.totalMarketValue ?? 0)), renderAmountToggle()),
            hasLiabilities ? h("span", {}, "负债 ", h("strong", { class: "ledger-amount" }, fmtAmount(summary.liabilityTotal ?? 0))) : null,
            hasLiabilities ? h("span", {}, "净资产 ", h("strong", { class: "ledger-amount" }, fmtAmount(summary.netMarketValue ?? 0))) : null,
            h("span", {}, "股东 ", h("strong", {}, String(summary.shareholderCount ?? 0))),
            hasLiabilities ? h("span", {}, "债权人 ", h("strong", {}, String(summary.creditorCount ?? 0))) : null,
            h("span", {}, "动账 ", h("strong", {}, String(summary.transactionCount ?? 0)), " 笔")),
          L.error ? h("p", { class: "field-error ledger-notice", role: "alert" }, L.error) : null,
          L.message ? h("p", { class: "ledger-notice ledger-ok", role: "status" }, L.message) : null,
          L.create ? renderCreateForm() : null,
          accountSection,
          // 明细紧跟在账户卡片下面（同一个左栏），右侧记账助手不会把这一列撑出空白
          renderLedgerHistory(),
          renderRules()),
        renderChatPanel()));
  }

  function renderRules() {
    return h("details", { class: "ledger-rules muted small" },
      h("summary", {}, "记账口径"),
      h("p", {}, "股东占比 = 股东权益 ÷ 账户市值，由服务端计算；不单独保存百分比，避免和金额对不上。"),
      h("p", {}, "入金 / 出金时，股票本身的涨跌按动账前占比分给所有股东，资金只加减到操作股东身上；因此「动账后市值」填你实际看到的最新市值即可。"),
      h("p", {}, "股东间转让只改股东权益，不改账户市值；只改市值（股票涨跌）用「市值更新」，占比保持不变。"),
      h("p", {}, "金额按人民币元记录，最多两位小数；界面统一换算成「万」展示（保留 1 位小数）。所有账户的动账都合在页面底部的「动账明细」里，每笔都能回看动账前后的完整占比；每个账户最近写入的一笔可以撤销。"),
      h("p", {}, "负债账户记录「欠债权人的钱」：账面是未还余额，债权人的占比 = 各自债权 ÷ 总负债。借钱记「借款」（余额增加），还钱记「还款」（余额减少）；负债不计入资产合计，会单独列出并算出净资产。"),
      h("p", {}, "记账助手也是写入同一套接口：它只决定「记什么」，占比、市值分摊和幂等由服务端账本算；对不上账户或股东时会先问你。手机上的对话收成屏幕底部的输入框，点「记录」展开。会话里的 agent 也能用平台技能「股票账户记账」做同样的事。"));
  }

  /**
   * 紧凑账户卡片：几个账户并排成一行、可左右横滑；卡片上只放现状（市值 / 余额、股东占比）和两个动作，
   * 动账流水统一在页面底部的「动账明细」里，表单在卡片带下面整宽展开。
   */
  function renderAccount(account) {
    const txs = txFor(account.id);
    const liability = accountIsLiability(account);
    const shareNoun = liability ? "债权人" : "股东";
    const equityNoun = liability ? "债权" : "权益";
    const total = account.shareholders.reduce((sum, s) => sum + Number(s.equity || 0), 0);
    const editing = !!L.edit && L.edit.accountId === account.id;
    const recording = !!L.form && L.form.accountId === account.id;
    const meta = [account.broker, account.accountNo].filter(Boolean).join(" · ");
    const subline = [meta, account.note].filter(Boolean).join(" · ");
    return h("article", { class: "card ledger-account is-compact" + (editing || recording ? " is-active" : "") + (liability ? " is-liability" : "") },
      h("div", { class: "ledger-account-head" },
        h("div", { class: "ledger-account-title" },
          h("h2", { title: account.name }, account.name,
            liability ? h("span", { class: "ledger-kind ledger-kind-withdraw ledger-account-badge" }, "负债") : null),
          h("p", { class: "muted small ledger-account-note", title: subline || undefined }, subline || (liability ? "负债账户 · 余额按未还款项记录" : "未填写券商 / 账号"))),
        h("div", { class: "ledger-account-value" },
          h("span", { class: "ledger-label" }, liability ? "余额" : "市值"),
          h("strong", { class: "ledger-amount" }, fmtAmount(account.marketValue)))),
      h("div", { class: "ledger-shareholders" },
        h("div", { class: "ledger-shareholder-head" },
          h("span", {}, shareNoun),
          h("span", {}, "占比"),
          h("span", {}, equityNoun)),
        account.shareholders.map((s) => h("div", { class: "ledger-shareholder" },
          h("div", { class: "ledger-shareholder-name" }, h("span", {}, s.name)),
          h("span", { class: "ledger-shareholder-pct" }, pct(s.percent)),
          h("span", { class: "ledger-shareholder-equity ledger-amount" }, fmtAmount(s.equity)))),
        total > 0 && Math.abs(total - Number(account.marketValue)) > 0.005
          ? h("p", { class: "field-error small" }, `${shareNoun}${equityNoun}合计与${liability ? "余额" : "市值"}不一致，请检查数据。`)
          : null),
      h("div", { class: "ledger-account-actions" },
        h("span", { class: "muted small" }, txs.length
          ? `${txs.length} 笔动账 · 最近 ${fmtTime(latestOccurred(txs))}`
          : "还没有动账"),
        h("span", { class: "ledger-spacer" }),
        h("button", { class: "btn small", type: "button", onclick: () => {
          L.open = account.id; L.form = null;
          L.edit = {
            accountId: account.id, name: account.name, broker: account.broker || "", accountNo: account.accountNo || "", note: account.note || "",
            shareholders: account.shareholders.map((s) => ({ id: s.shareholderId, name: s.name, percent: s.percent }))
          };
          L.error = ""; renderMain();
        } }, "编辑"),
        h("button", { class: "btn primary small", type: "button", onclick: () => {
          L.open = account.id; L.error = "";
          if (recording) { L.form = null; } else { L.form = newTxForm(account); L.edit = null; }
          renderMain();
        } }, recording ? "取消记账" : (liability ? "记一笔借款 / 还款" : "记一笔动账"))));
  }

  /** 卡片带下面的整宽表单：正在编辑或记一笔的那个账户（卡片太窄，表单在里面放不下）。 */
  function renderAccountForm() {
    const account = (L.edit && accountById(L.edit.accountId)) || (L.form && accountById(L.form.accountId)) || null;
    if (!account) return null;
    return h("div", { class: "card ledger-account-form" },
      h("p", { class: "muted small ledger-form-context" }, `账户：${account.name}${accountIsLiability(account) ? "（负债）" : ""}`),
      L.edit ? renderEditForm(account) : renderTxForm(account));
  }

  /** 一个账户的「最近动账」按业务时间算（倒推补录的历史不会顶到最前面）。 */
  function latestOccurred(txs) {
    return txs.reduce((latest, tx) => (String(tx.occurredAt) > String(latest) ? tx.occurredAt : latest), txs[0].occurredAt);
  }

  /* --------------------------- 动账明细（账单式流水） --------------------------- */

  // 行首图标按动账类型画：钱进来 / 钱出去 / 两边换 / 折线（只调市值余额）。和导航一套 24px 描边。
  const KIND_ICON = {
    deposit: ["M12 4.5v9.5", "M8 10.5 12 14.5l4-4", "M5.5 17.5v1A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5v-1"],
    withdraw: ["M12 19.5V10", "M8 13.5 12 9.5l4 4", "M5.5 6.5v-1A1.5 1.5 0 0 1 7 4h10a1.5 1.5 0 0 1 1.5 1.5v1"],
    transfer: ["M4 9h12.5", "M13 5.5 16.5 9 13 12.5", "M20 15H7.5", "M11 11.5 7.5 15 11 18.5"],
    revalue: ["M4 16.5 9.5 11l3 3L20 7", "M15.5 7H20v4.5"]
  };
  const pad2 = (n) => String(n).padStart(2, "0");
  /** 账单行的时间：「9/30 12:00」，不是今年的补上年份；账单不再按天分组，所以每行都带日期。 */
  const billTime = (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso || "");
    const year = date.getFullYear() === new Date().getFullYear() ? "" : `${date.getFullYear()}/`;
    return `${year}${date.getMonth() + 1}/${date.getDate()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  };
  const timeCutoff = (def) => {
    if (def.year) return new Date(new Date().getFullYear(), 0, 1).getTime();
    return def.days ? Date.now() - def.days * 86400000 : null;
  };
  /** 账单金额统一「¥ + 万」；眼睛闭着时只留占位符，和页面其它金额一个口径。 */
  const moneyText = (value) => `¥${fmtAmount(value)}`;
  /** 一笔动账在账单上的方向与金额：市值 / 余额更新按变化量算，转让是中性（钱还在账户里）。 */
  function flowOf(tx) {
    if (tx.kind === "deposit") return { sign: "+", tone: "in", value: Number(tx.amount) || 0 };
    if (tx.kind === "withdraw") return { sign: "-", tone: "out", value: Number(tx.amount) || 0 };
    if (tx.kind === "revalue") {
      const delta = (Number(tx.marketValueAfter) || 0) - (Number(tx.marketValueBefore) || 0);
      return { sign: delta < 0 ? "-" : "+", tone: "flat", value: Math.abs(delta) };
    }
    return { sign: "", tone: "flat", value: Number(tx.amount) || 0 };
  }
  /** 账单标题只写「谁 + 什么动作」，金额放右边单独一列（银行卡账单的读法）。 */
  function txTitle(tx, liability) {
    const who = tx.shareholderName || "—";
    if (tx.kind === "transfer") return `${who} → ${tx.counterpartyName || "—"} ${liability ? "债权转让" : "转让"}`;
    if (tx.kind === "revalue") return liability ? "余额调整" : "市值更新";
    if (liability) return `向 ${who} ${tx.kind === "deposit" ? "借款" : "还款"}`;
    return `${who} ${KIND_LABEL[tx.kind] || "动账"}`;
  }
  /**
   * 动账明细：所有账户的流水按银行卡账单的样子排——行首类型图标，第一行「谁 + 动作」与带符号金额，
   * 第二行「账户 · 时间」与动账后市值 / 余额；统一按发生时间倒序，不分组，一次 20 笔、滚到底自动加载。
   * 账户卡片在上面只看现状，翻历史都在这里。
   */
  function renderLedgerHistory() {
    const all = txList();
    if (!all.length) return null;
    // 撤销只对「该账户最近写入的一笔」有效：服务端按写入顺序判定，这里按 recordedAt 取每个账户最新的一笔。
    const latestByAccount = new Map();
    for (const tx of all) {
      const current = latestByAccount.get(tx.accountId);
      if (!current || String(tx.recordedAt || "").localeCompare(String(current.recordedAt || "")) > 0) latestByAccount.set(tx.accountId, tx);
    }
    const filterAccount = L.history.account;
    const filterKind = L.history.kind;
    const kindDef = HISTORY_KIND_FILTERS.find((item) => item.id === filterKind) || HISTORY_KIND_FILTERS[0];
    const timeDef = HISTORY_TIME_FILTERS.find((item) => item.id === L.history.time) || HISTORY_TIME_FILTERS[0];
    const cutoff = timeCutoff(timeDef);
    const filtered = all.filter((tx) => (filterAccount === "all" || tx.accountId === filterAccount)
      && (!kindDef.kinds || kindDef.kinds.includes(tx.kind))
      && (cutoff === null || new Date(tx.occurredAt).getTime() >= cutoff));
    const rows = [...filtered].sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt))
      || String(b.recordedAt || "").localeCompare(String(a.recordedAt || "")));
    const total = Number(ui.ledger && ui.ledger.transactionTotal) || all.length;
    const filteredNow = filterAccount !== "all" || kindDef.id !== "all" || timeDef.id !== "all";
    const countText = filteredNow
      ? `${rows.length} 笔 / 共 ${all.length} 笔`
      : (all.length < total ? `显示最近 ${all.length} 笔 / 共 ${total} 笔` : `${all.length} 笔`);
    const activeAccount = filterAccount === "all" ? null : accountById(filterAccount);
    const rowFor = (tx) => renderTransaction(tx, { latest: latestByAccount.get(tx.accountId) === tx });
    const list = h("div", { class: "ledger-bill-list" });
    const shown = Math.min(Math.max(L.history.limit, HISTORY_PAGE_SIZE), rows.length);
    for (const tx of rows.slice(0, shown)) list.appendChild(rowFor(tx));
    if (L.history.observer) { L.history.observer.disconnect(); L.history.observer = null; }
    if (shown < rows.length) list.appendChild(moreSentinel(list, rows, rowFor));
    return h("section", { class: "card ledger-history", "aria-label": "动账明细" },
      h("div", { class: "ledger-history-head" },
        h("h2", {}, "动账明细"),
        h("span", { class: "muted small ledger-history-count" }, countText)),
      !filteredNow
        ? h("p", { class: "muted small ledger-history-sub" }, "所有账户的动账按时间倒序合在一起，每笔都保留动账前后的完整占比；每个账户最近写入的一笔可以撤销。")
        : h("p", { class: "muted small ledger-history-sub" }, [
          filterAccount === "all" ? "所有账户" : `只看「${activeAccount ? activeAccount.name : "账户"}」`,
          kindDef.id === "all" ? "" : ` · ${kindDef.label}`,
          timeDef.id === "all" ? "" : ` · ${timeDef.label}`,
          "；每笔都保留动账前后的完整占比。"
        ].join("")),
      // 三个筛选平分一行，不横滑：和待办「分类 / 完成状态」筛选同一个下拉组件（胶囊触发器 + 自绘菜单），不用系统选择器
      h("div", { class: "ledger-bill-filters" },
        filterDropdown("account", "账户", [
          { key: "all", label: "全部账户" },
          ...accountList().map((account) => ({ key: account.id, label: accountIsLiability(account) ? `${account.name}（负债）` : account.name }))
        ], filterAccount, (value) => { L.history.account = value; }),
        filterDropdown("kind", "类型", HISTORY_KIND_FILTERS.map((item) => ({ key: item.id, label: item.label })), filterKind, (value) => { L.history.kind = value; }),
        filterDropdown("time", "时间", HISTORY_TIME_FILTERS.map((item) => ({ key: item.id, label: item.label })), timeDef.id, (value) => { L.history.time = value; })),
      rows.length ? list : h("p", { class: "muted small ledger-history-empty" }, "这个筛选下没有动账。"));
  }

  /**
   * 账单筛选的一个下拉：和待办页的「完成状态 / 分类」筛选同一套样式与交互——
   * 收起时是胶囊，只显示当前取值；点开在下面弹出自绘菜单，选一项后收起并回到第一页；
   * 点别处或按 Esc 收起。同一时间只开一个。
   */
  function filterDropdown(key, label, options, current, apply) {
    const open = L.history.menu === key;
    const selected = options.find((item) => item.key === current) || options[0];
    return h("div", { class: "notes-filter-dropdown ledger-filter-dropdown" + (open ? " open" : ""), "data-filter-dim": key },
      h("button", {
        type: "button", class: "notes-filter notes-filter-trigger ledger-filter-trigger" + (open ? " open" : ""),
        "aria-haspopup": "listbox", "aria-expanded": String(open),
        "aria-label": `按${label}筛选：${selected.label}`, title: selected.label,
        onclick: () => { L.history.menu = open ? null : key; renderMain(); }
      },
        h("span", { class: "notes-filter-label ledger-filter-label" }, selected.label),
        h("span", { class: "notes-filter-caret", "aria-hidden": "true" }, "▾")),
      open ? h("div", { class: "notes-filter-menu ledger-filter-menu", role: "listbox", "aria-label": `${label}筛选` },
        options.map((item) => h("button", {
          type: "button", role: "option", class: "notes-filter-option" + (item.key === selected.key ? " active" : ""),
          "aria-selected": String(item.key === selected.key), "data-filter-value": item.key,
          onclick: () => { apply(item.key); L.history.menu = null; L.history.limit = HISTORY_PAGE_SIZE; renderMain(); }
        }, h("span", { class: "notes-filter-label" }, item.label)))) : null);
  }
  const closeHistoryMenu = () => {
    if (!L.history.menu) return;
    L.history.menu = null;
    if (ui.view === "ledger") renderMain();
  };
  document.addEventListener("click", (event) => {
    if (L.history.menu && !(event.target instanceof Element && event.target.closest(".ledger-filter-dropdown"))) closeHistoryMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && L.history.menu) closeHistoryMenu();
  });

  /**
   * 列表尾部的「正在加载更多」：滚到它附近就把下一页接在后面（只追加这一页，不重绘整个页面，
   * 滚动位置不动）；点它也能加载，兼顾没有 IntersectionObserver 的环境。
   */
  function moreSentinel(list, rows, rowFor) {
    const sentinel = h("button", { class: "ledger-bill-more muted small", type: "button" }, "加载更多");
    const loadMore = () => {
      const next = Math.min(L.history.limit + HISTORY_PAGE_SIZE, rows.length);
      const from = Math.min(L.history.limit, rows.length);
      L.history.limit = next;
      for (const tx of rows.slice(from, next)) list.insertBefore(rowFor(tx), sentinel);
      if (next >= rows.length) {
        if (L.history.observer) { L.history.observer.disconnect(); L.history.observer = null; }
        sentinel.remove();
      }
    };
    sentinel.addEventListener("click", loadMore);
    if (typeof IntersectionObserver === "function") {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      }, { rootMargin: "240px 0px" });
      observer.observe(sentinel);
      L.history.observer = observer;
    }
    return sentinel;
  }

  /** 账单的一行：图标 + 两行文字（谁 + 动作 / 金额；账户 · 时间 / 动账后市值）；点行展开备注与占比明细。 */
  function renderTransaction(tx, options = {}) {
    const { latest = false } = options;
    const account = accountById(tx.accountId);
    const open = L.txOpen.has(tx.id);
    const liability = accountIsLiability(account);
    const label = kindLabel(tx.kind, account);
    const flow = flowOf(tx);
    const afterNoun = liability ? "余额" : "市值";
    const who = [tx.accountName || (account && account.name) || "未知账户", billTime(tx.occurredAt)];
    // 「不计入」的账：转让不改市值、市值更新不动钱，展开区里给一个说明它怎么算
    const tag = tx.kind === "transfer" ? "不计入市值" : tx.kind === "revalue" ? (liability ? "只改余额" : "只改市值") : "";
    const afterRows = tx.after.map((row) => `${row.name} ${pct(row.percent)}`).join(" · ");
    return h("article", { class: "ledger-tx ledger-bill" + (open ? " is-open" : "") },
      h("button", {
        class: "ledger-bill-row", type: "button", "aria-expanded": String(open),
        onclick: () => {
          if (open) L.txOpen.delete(tx.id); else L.txOpen.add(tx.id);
          renderMain();
        }
      },
        h("span", { class: "ledger-bill-icon ledger-kind-" + tx.kind, title: label, "aria-hidden": "true" },
          iconSvg(KIND_ICON[tx.kind] || KIND_ICON.revalue, { className: "ledger-bill-glyph", size: 18 })),
        h("span", { class: "ledger-bill-main" },
          h("span", { class: "ledger-bill-line" },
            h("strong", { class: "ledger-bill-title" }, txTitle(tx, liability)),
            h("strong", { class: "ledger-bill-money is-" + flow.tone }, flow.sign, moneyText(flow.value))),
          h("span", { class: "ledger-bill-line" },
            h("span", { class: "ledger-bill-sub" }, who.join(" · ")),
            h("span", { class: "ledger-bill-balance" }, `${afterNoun} ${moneyText(tx.marketValueAfter)}`))),
        h("span", { class: "ledger-bill-caret", "aria-hidden": "true" }, "›")),
      open ? h("div", { class: "ledger-tx-detail" },
        // 备注详情：一行放动账后每个人的占比，备注、记录来源和计算口径跟在后面
        h("p", { class: "ledger-tx-remark" },
          h("span", { class: "ledger-tx-remark-ratio" }, `动账后占比：${afterRows}`),
          tx.note ? h("span", { class: "ledger-tx-note-text" }, `备注：${tx.note}`) : null,
          tag ? h("span", { class: "ledger-bill-tag" }, tag) : null,
          tx.actor === "agent" ? h("span", { class: "badge accent" }, "agent 记账") : null),
        h("p", { class: "ledger-tx-mv" }, `${afterNoun} `,
          h("span", { class: "ledger-amount" }, fmtAmount(tx.marketValueBefore)), " → ",
          h("strong", { class: "ledger-amount" }, fmtAmount(tx.marketValueAfter))),
        h("div", { class: "ledger-ratio-change" }, tx.after.map((row) => {
          const before = tx.before.find((item) => item.shareholderId === row.shareholderId);
          const changed = !before || Math.abs(Number(before.percent) - Number(row.percent)) > 0.00005;
          return h("span", { class: "ledger-ratio-chip" + (changed ? " changed" : "") },
            h("span", { class: "ledger-ratio-name" }, row.name),
            " ", before ? pct(before.percent) : "—", " → ", h("strong", {}, pct(row.percent)));
        })),
        h("table", { class: "ledger-table" },
          h("thead", {}, h("tr", {},
            h("th", {}, liability ? "债权人" : "股东"),
            h("th", { title: `动账前${liability ? "债权" : "权益"}` }, `前${liability ? "债权" : "权益"}`),
            h("th", { title: `动账后${liability ? "债权" : "权益"}` }, `后${liability ? "债权" : "权益"}`),
            h("th", {}, "占比"))),
          h("tbody", {}, tx.after.map((row) => {
            const before = tx.before.find((item) => item.shareholderId === row.shareholderId);
            return h("tr", {},
              h("td", {}, row.name),
              h("td", { class: "ledger-amount" }, before ? fmtAmount(before.equity) : "—"),
              h("td", { class: "ledger-amount" }, fmtAmount(row.equity)),
              h("td", {}, before ? `${pct(before.percent)} → ${pct(row.percent)}` : `— → ${pct(row.percent)}`));
          }))),
        latest ? h("div", { class: "ledger-tx-actions" },
          h("button", { class: "btn ghost small", type: "button", disabled: !!L.busy, onclick: () => undoTransaction(tx) }, "撤销这笔")) : null) : null);
  }

  /* ------------------------------- 新建账户 ------------------------------- */

  function newCreateDraft() {
    return { kind: "asset", name: "", broker: "", accountNo: "", note: "", marketValue: "", shareholders: [{ name: "", percent: "" }, { name: "", percent: "" }] };
  }

  function renderCreateForm() {
    const draft = L.create;
    const liability = draft.kind === "liability";
    const shareNoun = liability ? "债权人" : "股东";
    const total = draft.shareholders.reduce((sum, row) => sum + (Number(row.percent) || 0), 0);
    const form = h("form", { class: "card ledger-form ledger-create", onsubmit: (event) => { event.preventDefault(); void submitCreate(); } },
      h("h2", {}, liability ? "新建负债账户" : "新建股票账户"),
      h("div", { class: "ledger-form-grid" },
        field("账户类型", h("select", { value: draft.kind, onchange: (e) => { draft.kind = e.target.value; renderMain(); } },
          h("option", { value: "asset", selected: draft.kind === "asset" }, "资产账户（股票 / 理财）"),
          h("option", { value: "liability", selected: draft.kind === "liability" }, "负债账户（欠款）"))),
        field("账户名称", h("input", { required: true, maxlength: "60", placeholder: liability ? "例如：个人负债" : "例如：平安证券主账户", value: draft.name, oninput: (e) => { draft.name = e.target.value; } })),
        liability ? null : field("券商", h("input", { maxlength: "60", placeholder: "选填", value: draft.broker, oninput: (e) => { draft.broker = e.target.value; } })),
        liability ? null : field("账号", h("input", { maxlength: "60", placeholder: "选填，只作备注", value: draft.accountNo, oninput: (e) => { draft.accountNo = e.target.value; } })),
        field(liability ? "当前负债余额（元）" : "当前市值（元）", h("input", { required: true, inputmode: "decimal", placeholder: liability ? "例如 269000" : "例如 1200000.00", value: draft.marketValue, oninput: (e) => { draft.marketValue = e.target.value; } })),
        field("备注（选填）", h("input", { maxlength: "500", placeholder: liability ? "例如：欠小红 20 万" : "选填", value: draft.note, oninput: (e) => { draft.note = e.target.value; } }))),
      h("div", { class: "ledger-shareholder-editor" },
        h("div", { class: "ledger-shareholder-head" }, h("span", {}, shareNoun), h("span", {}, liability ? "债权占比 %" : "初始占比 %"), h("span", {}, "")),
        draft.shareholders.map((row, index) => h("div", { class: "ledger-shareholder-edit-row" },
          h("input", { required: true, maxlength: "60", placeholder: `${shareNoun} ${index + 1}`, value: row.name, oninput: (e) => { row.name = e.target.value; } }),
          h("input", { required: true, inputmode: "decimal", placeholder: "例如 60", value: row.percent, oninput: (e) => { row.percent = e.target.value; updateCreateTotal(); } }),
          h("button", { class: "btn ghost small", type: "button", disabled: draft.shareholders.length <= 1, onclick: () => { draft.shareholders.splice(index, 1); renderMain(); } }, "删除"))),
        h("div", { class: "ledger-shareholder-edit-foot" },
          h("button", { class: "btn small", type: "button", onclick: () => { draft.shareholders.push({ name: "", percent: "" }); renderMain(); } }, `添加${shareNoun}`),
          h("span", { class: "ledger-total" + (Math.abs(total - 100) < 0.00005 ? " ok" : " bad"), id: "ledger-create-total" }, `占比合计 ${total.toFixed(2)}%`))),
      h("div", { class: "ledger-form-actions" },
        h("span", { class: "muted small" }, liability
          ? "占债权合计必须是 100%。余额为 0 时先建一个 100% 债权人，之后用「借款」累加。"
          : "占比合计必须是 100%。市值为 0 时先建一个 100% 股东，之后用入金添加其他股东。"),
        h("span", { class: "ledger-spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => { L.create = null; L.error = ""; renderMain(); } }, "取消"),
        h("button", { class: "btn primary", type: "submit", disabled: !!L.busy }, L.busy || "创建账户")));
    return form;
  }

  function updateCreateTotal() {
    const el = document.getElementById("ledger-create-total");
    if (!el || !L.create) return;
    const total = L.create.shareholders.reduce((sum, row) => sum + (Number(row.percent) || 0), 0);
    el.textContent = `占比合计 ${total.toFixed(2)}%`;
    el.classList.toggle("ok", Math.abs(total - 100) < 0.00005);
    el.classList.toggle("bad", Math.abs(total - 100) >= 0.00005);
  }

  async function submitCreate() {
    if (!L.create || L.busy) return;
    const draft = L.create;
    const total = draft.shareholders.reduce((sum, row) => sum + (Number(row.percent) || 0), 0);
    if (Math.abs(total - 100) >= 0.00005) { L.error = `占比合计要是 100%，现在是 ${total.toFixed(4).replace(/\.?0+$/, "")}%`; renderMain(); return; }
    await runWrite(async () => {
      const result = await api("/api/ledger/accounts", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name, kind: draft.kind, broker: draft.broker, accountNo: draft.accountNo, note: draft.note,
          marketValue: draft.marketValue,
          shareholders: draft.shareholders.map((row) => ({ name: row.name, percent: row.percent }))
        })
      });
      L.create = null;
      L.open = result?.account?.id || null;
      return `已创建${draft.kind === "liability" ? "负债" : ""}账户「${result?.account?.name || draft.name}」`;
    });
  }

  /* ------------------------------- 动账 ------------------------------- */

  function newTxForm(account) {
    return {
      accountId: account.id,
      kind: "deposit",
      shareholderId: account.shareholders[0]?.shareholderId || "",
      newName: "",
      counterpartyId: account.shareholders[1]?.shareholderId || account.shareholders[0]?.shareholderId || "",
      amount: "",
      marketValueAfter: "",
      note: "",
      occurredAt: "",
      idempotencyKey: newIdempotencyKey()
    };
  }

  function renderTxForm(account) {
    const draft = L.form;
    const kind = draft.kind;
    const liability = accountIsLiability(account);
    const shareNoun = liability ? "债权人" : "股东";
    const balanceNoun = liability ? "余额" : "市值";
    const target = draft.shareholderId === NEW_SHAREHOLDER ? null : shareholderById(account, draft.shareholderId);
    const flowDirection = kind === "deposit" ? "加" : "减";
    const defaultValue = kind === "deposit"
      ? `默认 ${fmtAmount(Number(account.marketValue) + (Number(draft.amount) || 0))}（${balanceNoun} + ${liability ? "借款" : "入金"}）`
      : `默认 ${fmtAmount(Math.max(0, Number(account.marketValue) - (Number(draft.amount) || 0)))}（${balanceNoun} - ${liability ? "还款" : "出金"}）`;
    const shareholderOptions = (selected) => account.shareholders.map((s) => h("option", { value: s.shareholderId, selected: s.shareholderId === selected }, `${s.name}（${pct(s.percent)}）`));
    return h("form", { class: "ledger-form", onsubmit: (event) => { event.preventDefault(); void submitTransaction(); } },
      h("div", { class: "ledger-form-head" },
        h("h3", {}, liability ? "记一笔借款 / 还款" : "记一笔动账"),
        h("span", { class: "muted small" }, kindHint(kind, account))),
      h("div", { class: "ledger-form-grid" },
        field("动账类型", h("select", { value: kind, onchange: (e) => {
          draft.kind = e.target.value;
          if (draft.shareholderId === NEW_SHAREHOLDER && draft.kind !== "deposit") draft.shareholderId = account.shareholders[0]?.shareholderId || "";
          if (draft.kind === "transfer" && draft.counterpartyId === draft.shareholderId) {
            draft.counterpartyId = account.shareholders.find((s) => s.shareholderId !== draft.shareholderId)?.shareholderId || "";
          }
          renderMain();
        } },
          Object.entries(liability ? LIABILITY_KIND_LABEL : KIND_LABEL).map(([value, label]) => h("option", { value, selected: value === kind }, label)))),
        kind === "deposit" || kind === "withdraw" ? field(shareNoun, h("select", { value: draft.shareholderId, onchange: (e) => { draft.shareholderId = e.target.value; renderMain(); } },
          shareholderOptions(draft.shareholderId),
          kind === "deposit" ? h("option", { value: NEW_SHAREHOLDER, selected: draft.shareholderId === NEW_SHAREHOLDER }, `＋ 新${shareNoun}`) : null)) : null,
        kind === "deposit" && draft.shareholderId === NEW_SHAREHOLDER ? field(`新${shareNoun}姓名`, h("input", { required: true, maxlength: "60", placeholder: liability ? "例如：小红" : "例如：王五", value: draft.newName, oninput: (e) => { draft.newName = e.target.value; } })) : null,
        kind === "transfer" ? field(`转出${shareNoun}`, h("select", { value: draft.shareholderId, onchange: (e) => { draft.shareholderId = e.target.value; renderMain(); } }, shareholderOptions(draft.shareholderId))) : null,
        kind === "transfer" ? field(`转入${shareNoun}`, h("select", { value: draft.counterpartyId, onchange: (e) => { draft.counterpartyId = e.target.value; } }, account.shareholders.map((s) => h("option", { value: s.shareholderId, selected: s.shareholderId === draft.counterpartyId, disabled: s.shareholderId === draft.shareholderId }, `${s.name}（${pct(s.percent)}）`)))) : null,
        kind !== "revalue" ? field(kind === "transfer" ? "转让金额（元）" : liability ? (kind === "deposit" ? "借款金额（元）" : "还款金额（元）") : "动账金额（元）", h("input", { required: true, inputmode: "decimal", placeholder: "例如 100000.00", value: draft.amount, oninput: (e) => { draft.amount = e.target.value; } })) : null,
        kind !== "transfer" ? field(kind === "revalue" ? `新的${balanceNoun}（元）` : `动账后${balanceNoun}（元）`, h("input", {
          required: kind === "revalue", inputmode: "decimal",
          placeholder: kind === "revalue" ? `当前 ${fmtAmount(account.marketValue)}` : `留空则${flowDirection === "加" ? "加" : "减"}去金额`,
          value: draft.marketValueAfter, oninput: (e) => { draft.marketValueAfter = e.target.value; }
        })) : null,
        field("动账时间（选填）", h("input", { type: "datetime-local", value: draft.occurredAt, oninput: (e) => { draft.occurredAt = e.target.value; } }))),
      kind === "deposit" || kind === "withdraw" ? h("p", { class: "muted small ledger-form-hint" }, defaultValue) : null,
      field("备注（选填）", h("input", { maxlength: "500", placeholder: liability ? "例如：12/8 借款 / 还款 4 万" : "例如：追加资金 / 转给李四", value: draft.note, oninput: (e) => { draft.note = e.target.value; } })),
      h("div", { class: "ledger-form-actions" },
        h("span", { class: "muted small" }, target ? `当前 ${target.name} 占比 ${pct(target.percent)}` : ""),
        h("span", { class: "ledger-spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => { L.form = null; L.error = ""; renderMain(); } }, "取消"),
        h("button", { class: "btn primary", type: "submit", disabled: !!L.busy }, L.busy || "保存动账")));
  }

  function renderEditForm(account) {
    const draft = L.edit;
    return h("form", { class: "ledger-form ledger-edit", onsubmit: (event) => { event.preventDefault(); void submitEdit(); } },
      h("div", { class: "ledger-form-head" },
        h("h3", {}, "编辑账户信息"),
        h("span", { class: "muted small" }, `只改名称和备注，不影响${accountIsLiability(account) ? "余额、债权" : "市值、股东占比"}和历史动账。`)),
      h("div", { class: "ledger-form-grid" },
        field("账户名称", h("input", { required: true, maxlength: "60", value: draft.name, oninput: (e) => { draft.name = e.target.value; } })),
        accountIsLiability(account) ? null : field("券商", h("input", { maxlength: "60", placeholder: "选填", value: draft.broker, oninput: (e) => { draft.broker = e.target.value; } })),
        accountIsLiability(account) ? null : field("账号", h("input", { maxlength: "60", placeholder: "选填，只作备注", value: draft.accountNo, oninput: (e) => { draft.accountNo = e.target.value; } })),
        field("备注", h("input", { maxlength: "500", placeholder: "选填", value: draft.note, oninput: (e) => { draft.note = e.target.value; } }))),
      h("div", { class: "ledger-shareholder-editor" },
        h("p", { class: "field-label" }, accountIsLiability(account) ? "债权人姓名（改历史标签，不影响债权）" : "股东姓名（改历史标签，不影响权益）"),
        draft.shareholders.map((row) => h("div", { class: "ledger-shareholder-edit-row ledger-shareholder-rename-row" },
          h("input", { required: true, maxlength: "60", value: row.name, "aria-label": `${accountIsLiability(account) ? "债权人" : "股东"}姓名 ${row.name}`, oninput: (e) => { row.name = e.target.value; } }),
          h("span", { class: "muted small" }, pct(row.percent))))),
      h("div", { class: "ledger-form-actions" },
        account.transactionCount === 0
          ? h("button", { class: "btn danger small", type: "button", disabled: !!L.busy, onclick: () => void deleteAccount(account) }, "删除账户")
          : h("span", { class: "muted small" }, `已有 ${account.transactionCount} 笔动账，账户不能删除；记错了请用反方向的动账修正。`),
        h("span", { class: "ledger-spacer" }),
        h("button", { class: "btn", type: "button", onclick: () => { L.edit = null; L.error = ""; renderMain(); } }, "取消"),
        h("button", { class: "btn primary", type: "submit", disabled: !!L.busy }, L.busy || "保存")));
  }

  async function submitEdit() {
    if (!L.edit || L.busy) return;
    const draft = L.edit;
    await runWrite(async () => {
      const result = await api(`/api/ledger/accounts/${encodeURIComponent(draft.accountId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: draft.name, broker: draft.broker, accountNo: draft.accountNo, note: draft.note,
          shareholders: draft.shareholders.map((row) => ({ id: row.id, name: row.name }))
        })
      });
      L.edit = null;
      return `已更新账户「${result?.account?.name || draft.name}」`;
    });
  }

  async function deleteAccount(account) {
    if (L.busy) return;
    if (!window.confirm(`删除空账户「${account.name}」？这个账户还没有动账记录，删除后不能恢复。`)) return;
    await runWrite(async () => {
      await api(`/api/ledger/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
      L.open = null; L.edit = null;
      return `已删除账户「${account.name}」`;
    });
  }

  async function submitTransaction() {
    const draft = L.form;
    if (!draft || L.busy) return;
    const account = accountById(draft.accountId);
    if (!account) { L.error = "账户不存在，请刷新"; renderMain(); return; }
    const body = { kind: draft.kind, idempotencyKey: draft.idempotencyKey };
    if (draft.kind === "deposit" || draft.kind === "withdraw") {
      if (draft.shareholderId === NEW_SHAREHOLDER) body.shareholderName = draft.newName;
      else body.shareholderId = draft.shareholderId;
      body.amount = draft.amount;
    }
    if (draft.kind === "transfer") {
      body.shareholderId = draft.shareholderId;
      body.counterpartyId = draft.counterpartyId;
      body.amount = draft.amount;
    }
    if (draft.kind === "revalue") body.marketValueAfter = draft.marketValueAfter;
    else if ((draft.kind === "deposit" || draft.kind === "withdraw") && draft.marketValueAfter !== "") body.marketValueAfter = draft.marketValueAfter;
    if (draft.note) body.note = draft.note;
    if (draft.occurredAt) body.occurredAt = new Date(draft.occurredAt).toISOString();
    await runWrite(async () => {
      const result = await api(`/api/ledger/accounts/${encodeURIComponent(draft.accountId)}/transactions`, { method: "POST", body: JSON.stringify(body) });
      L.form = null;
      return describeTransaction(result?.transaction, account);
    });
  }

  function describeTransaction(tx, account) {
    if (!tx) return "已记账";
    const liability = accountIsLiability(account);
    const target = tx.after.find((row) => row.shareholderId === tx.shareholderId);
    const before = tx.before.find((row) => row.shareholderId === tx.shareholderId);
    const who = tx.kind === "transfer"
      ? `${tx.shareholderName} → ${tx.counterpartyName} ${liability ? "债权转让" : "转让"} ${fmtMoney(tx.amount)}`
      : tx.kind === "revalue" ? `${liability ? "余额" : "市值"} ${fmtMoney(tx.marketValueBefore)} → ${fmtMoney(tx.marketValueAfter)}`
        : liability
          ? `向 ${tx.shareholderName} ${tx.kind === "deposit" ? "借款" : "还款"} ${fmtMoney(tx.amount)}`
          : `${tx.shareholderName} ${KIND_LABEL[tx.kind]} ${fmtMoney(tx.amount)}`;
    return target
      ? `已记账：${who}；${target.name} ${before ? pct(before.percent) : "—"} → ${pct(target.percent)}`
      : `已记账：${who}`;
  }

  async function undoTransaction(tx) {
    if (L.busy) return;
    const account = accountById(tx.accountId);
    const liability = accountIsLiability(account);
    const label = kindLabel(tx.kind, account);
    if (!window.confirm(`撤销这笔「${label}」（${fmtMoney(tx.amount)}）？撤销后占比和${liability ? "余额" : "市值"}回到动账前。`)) return;
    await runWrite(async () => {
      const result = await api(`/api/ledger/transactions/${encodeURIComponent(tx.id)}/undo`, { method: "POST", body: "{}" });
      return `已撤销：${label} ${fmtMoney(tx.amount)}；${liability ? "余额" : "市值"}回到 ${fmtMoney(result?.account?.marketValue ?? tx.marketValueBefore)}`;
    });
  }

  function field(label, control) {
    return h("label", { class: "field ledger-field" }, h("span", { class: "field-label" }, label), control);
  }

  Object.assign(window, { renderLedger, ledgerCloseChat: closeChatLog });
  window.piRouteModules?.register("ledger", { render: renderLedger });
})();
