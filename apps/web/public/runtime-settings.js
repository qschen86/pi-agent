/* A single background check on settings entry; native CLI login owns credentials. */
async function rtRecoverClaudeLogin(gen) {
  if (ui.view !== "runtimes" || gen !== ui.rt.gen || !ui.rt.access?.control || ui.rt.busy || ui.rt.claudeAuthRecovery) return;
  const p = ui.rt.profiles?.find(p => p.runtimeKind === "claude-code");
  if (p?.state !== "needs-login") return;
  ui.rt.claudeAuthRecovery = true;
  ui.rt.busy = "probe-claude-code";
  renderMain();
  try {
    await api("/api/runtime-profiles/claude-code/probe", { method: "POST", body: "{}" });
    await rtLoadProfiles();
  } catch (e) {
    if (gen === ui.rt.gen && ui.view === "runtimes") ui.rt.error = `Claude Code：${e.message}`;
  } finally {
    ui.rt.claudeAuthRecovery = false;
    if (ui.rt.busy === "probe-claude-code") ui.rt.busy = "";
    if (gen === ui.rt.gen && ui.view === "runtimes") renderMain();
  }
}

/* ------------------------------ 可视化连接与登录向导（无 CLI） ------------------------------ */

const RT_AUTH_META = {
  codex: {
    title: "Codex（ChatGPT / OpenAI）",
    hint: "在浏览器完成 OpenAI 官方授权，授权通过后会自动回传并完成校验，无需操作终端。",
    codePlaceholder: "",
  },
  "claude-code": {
    title: "Claude Code（Anthropic）",
    hint: "在浏览器打开 Claude 官方页授权；若页面自动完成登录将直接通过，若显示授权码可直接粘贴提交。",
    codePlaceholder: "粘贴 Claude 页面显示的授权码",
  },
  antigravity: {
    title: "Antigravity（Google AI Pro）",
    hint: "在浏览器用 Google 账号完成授权，然后将回调页上的授权码（或跳转后的完整网址）粘贴到这里。",
    codePlaceholder: "粘贴授权码或 https://antigravity.google/oauth-callback?…",
  },
  pi: {
    title: "Pi（API Key）",
    hint: "填写模型服务商的 API Key，平台将直连官方只读接口验证并隔离保存在本机。",
    codePlaceholder: "",
  },
};

function rtAuthState() {
  return ui.rt.authModal || (ui.rt.authModal = {
    open: false,
    kind: null,
    busy: "",
    error: "",
    flow: null,
    code: "",
    copied: false,
    networkKey: "",
    networkResult: null,
    apiProvider: "deepseek",
    apiKey: "",
    pollTimer: null,
  });
}

function rtStopAuthPoll() {
  const m = ui.rt.authModal;
  if (m?.pollTimer) { clearTimeout(m.pollTimer); m.pollTimer = null; }
}

async function rtLoadAuthCaps(force = false) {
  if (!ui.rt.access?.canEditSettings) return;
  if (ui.rt.authCapsLoading) return;
  if (!force && ui.rt.authCaps) return;
  ui.rt.authCapsLoading = true;
  try {
    ui.rt.authCaps = await api("/api/runtime-auth/capabilities");
  } catch {
    ui.rt.authCaps = { available: false, isolatedCredentials: false, runtimes: {} };
  } finally {
    ui.rt.authCapsLoading = false;
    if (ui.view === "runtimes" || ui.view === "settings") renderMain();
  }
}

function rtOpenAuthModal(kind) {
  rtStopAuthPoll();
  const m = rtAuthState();
  m.open = true;
  m.kind = kind;
  m.busy = "";
  m.error = "";
  m.flow = null;
  m.code = "";
  m.copied = false;
  m.networkKey = "";
  m.networkResult = null;
  m.apiProvider = "deepseek";
  m.apiKey = "";
  renderMain();
  void rtLoadAuthCaps(true);
}

async function rtCloseAuthModal(cancelFlow = false) {
  rtStopAuthPoll();
  const m = rtAuthState();
  const kind = m.kind, flowId = m.flow?.flowId;
  const active = m.flow && ["starting", "awaiting-auth", "submitting"].includes(m.flow.phase);
  m.open = false;
  m.kind = null;
  m.busy = "";
  m.error = "";
  m.code = "";
  m.apiKey = "";
  renderMain();
  if (cancelFlow && kind && active) {
    try { await api(`/api/runtime-auth/${kind}/cancel`, { method: "POST", body: JSON.stringify({ flowId }) }); } catch { /* ignore */ }
  }
}

function rtScheduleAuthPoll() {
  rtStopAuthPoll();
  const m = rtAuthState();
  if (!m.open || !m.kind || !m.flow?.flowId) return;
  if (!["starting", "awaiting-auth", "submitting", "verifying"].includes(m.flow.phase)) return;
  m.pollTimer = setTimeout(async () => {
    m.pollTimer = null;
    if (!m.open || !m.kind || !m.flow?.flowId) return;
    try {
      const res = await api(`/api/runtime-auth/${m.kind}/status?flowId=${encodeURIComponent(m.flow.flowId)}`);
      if (res?.flow) m.flow = res.flow;
      if (m.flow?.phase === "succeeded") {
        await Promise.allSettled([rtLoadProfiles(), rtLoadAuthCaps(true)]);
        announce(`${RT_KIND[m.kind]} 连接已通过`);
        renderMain();
        return;
      }
      if (m.flow?.phase === "failed" || m.flow?.phase === "cancelled") {
        if (m.flow.error) m.error = m.flow.error;
        renderMain();
        return;
      }
    } catch { /* 下轮重试 */ }
    renderMain();
    rtScheduleAuthPoll();
  }, 1800);
}

function rtAuthModal() {
  const m = ui.rt.authModal;
  if (!m?.open || !m.kind) return null;
  const kind = m.kind;
  const meta = RT_AUTH_META[kind] || { title: RT_KIND[kind], hint: "" };
  const cap = ui.rt.authCaps?.runtimes?.[kind] || {
    managedInstall: false,
    requiresNetworkGate: false,
    installed: true,
    enabled: true,
    isolatedCredentials: !!ui.rt.authCaps?.isolatedCredentials,
    supportsApiKey: kind === "pi" || kind === "codex",
    loginMode: kind === "pi" ? "api-key" : kind === "codex" ? "callback" : kind === "antigravity" ? "code-paste" : "hybrid",
  };
  const profile = (ui.rt.profiles || []).find((x) => x.runtimeKind === kind);
  const needsNetwork = !!cap.requiresNetworkGate;
  const networkPassed = !needsNetwork || !!m.networkResult?.decision?.allowed;
  const needsInstall = !!cap.managedInstall && !cap.installed;
  const installed = !needsInstall;
  const flow = m.flow;
  const flowRunning = !!(flow && ["starting", "awaiting-auth", "submitting", "verifying"].includes(flow.phase));
  const succeeded = flow?.phase === "succeeded";

  const runNetworkCheck = async () => {
    m.busy = "network"; m.error = ""; renderMain();
    try {
      m.networkResult = await api(`/api/runtime-auth/${kind}/network-check`, {
        method: "POST",
        body: JSON.stringify(m.networkKey.trim() ? { apiKey: m.networkKey.trim() } : {}),
      });
      m.networkKey = "";
    } catch (e) { m.error = e.message; }
    m.busy = ""; renderMain();
  };

  const runInstall = async () => {
    m.busy = "install"; m.error = ""; renderMain();
    try {
      const res = await api(`/api/runtime-auth/${kind}/install`, { method: "POST", body: "{}" });
      if (res?.capabilities) ui.rt.authCaps = { available: true, ...res.capabilities };
      else await rtLoadAuthCaps(true);
      await rtLoadProfiles().catch(() => {});
      announce(`${RT_KIND[kind]} 组件已安装`);
    } catch (e) { m.error = e.message; }
    m.busy = ""; renderMain();
  };

  const startLogin = async () => {
    m.busy = "start"; m.error = ""; m.copied = false; m.code = ""; renderMain();
    try {
      m.flow = await api(`/api/runtime-auth/${kind}/start`, { method: "POST", body: "{}" });
      if (m.flow?.authUrl) window.open(m.flow.authUrl, "_blank", "noopener,noreferrer");
      if (m.flow?.phase === "failed") m.error = m.flow.error || m.flow.message;
      else rtScheduleAuthPoll();
    } catch (e) { m.error = e.message; }
    m.busy = ""; renderMain();
  };

  const submitCode = async (ev) => {
    ev?.preventDefault?.();
    if (!m.flow?.flowId || !m.code.trim() || m.busy) return;
    m.busy = "submit"; m.error = ""; renderMain();
    try {
      m.flow = await api(`/api/runtime-auth/${kind}/submit`, {
        method: "POST",
        body: JSON.stringify({ flowId: m.flow.flowId, code: m.code.trim() }),
      });
      m.code = "";
      if (m.flow?.phase === "succeeded") {
        await Promise.allSettled([rtLoadProfiles(), rtLoadAuthCaps(true)]);
        announce(`${RT_KIND[kind]} 连接已通过`);
      } else {
        rtScheduleAuthPoll();
      }
    } catch (e) { m.error = e.message; }
    m.busy = ""; renderMain();
  };

  const submitPiKey = async (ev) => {
    ev?.preventDefault?.();
    if (!m.apiKey.trim() || m.busy) return;
    m.busy = "submit"; m.error = ""; renderMain();
    try {
      let current = m.flow;
      if (!current?.flowId || current.phase === "failed" || current.phase === "cancelled") {
        current = await api(`/api/runtime-auth/${kind}/start`, { method: "POST", body: "{}" });
        m.flow = current;
      }
      m.flow = await api(`/api/runtime-auth/${kind}/submit`, {
        method: "POST",
        body: JSON.stringify({ flowId: current.flowId, provider: m.apiProvider, apiKey: m.apiKey.trim() }),
      });
      m.apiKey = "";
      if (m.flow?.phase === "succeeded") {
        await Promise.allSettled([rtLoadProfiles(), rtLoadAuthCaps(true)]);
        announce("Pi API Key 已保存并验证通过");
      } else if (m.flow?.error) {
        m.error = m.flow.error;
      }
    } catch (e) { m.error = e.message; }
    m.busy = ""; renderMain();
  };

  const verifyNow = async () => {
    m.busy = "verify"; m.error = ""; renderMain();
    try {
      m.flow = await api(`/api/runtime-auth/${kind}/verify`, {
        method: "POST",
        body: JSON.stringify(m.flow?.flowId ? { flowId: m.flow.flowId } : {}),
      });
      if (m.flow?.phase === "succeeded") {
        await Promise.allSettled([rtLoadProfiles(), rtLoadAuthCaps(true)]);
        announce(`${RT_KIND[kind]} 连接已通过`);
      } else if (m.flow?.error) {
        m.error = m.flow.error;
      }
    } catch (e) { m.error = e.message; }
    m.busy = ""; renderMain();
  };

  const cancelFlow = async () => {
    rtStopAuthPoll();
    if (m.flow?.flowId) {
      try { await api(`/api/runtime-auth/${kind}/cancel`, { method: "POST", body: JSON.stringify({ flowId: m.flow.flowId }) }); } catch { /* ignore */ }
    }
    m.flow = null; m.code = ""; m.error = ""; renderMain();
  };

  const copyAuthUrl = async () => {
    if (!m.flow?.authUrl) return;
    try {
      await navigator.clipboard.writeText(m.flow.authUrl);
      m.copied = true; renderMain();
      setTimeout(() => { if (ui.rt.authModal) { ui.rt.authModal.copied = false; renderMain(); } }, 2000);
    } catch { m.error = "复制失败，请右键「打开官方登录页」复制链接"; renderMain(); }
  };

  let stepNo = 1;
  const steps = [];

  if (needsNetwork) {
    const netReport = m.networkResult?.report;
    const netLabels = { region: "支持地区", connectivity: "官方连通性", networkType: "IP 类型" };
    steps.push(h("section", { class: `rt-auth-step${networkPassed ? " is-done" : " is-active"}` },
      h("div", { class: "rt-auth-step-head" },
        h("span", { class: "rt-auth-num" }, networkPassed ? "✓" : String(stepNo)),
        h("h3", {}, "网络与地区检查"),
        badge(networkPassed ? "已通过" : "必检项", networkPassed ? "ok" : "warn")),
      h("div", { class: "rt-auth-row" },
        h("input", {
          type: "password", autocomplete: "off", placeholder: "ipapi.is API Key（已保存可留空）",
          "aria-label": "ipapi.is API Key", "data-key": "rt-auth-net-key",
          value: m.networkKey, disabled: !!m.busy,
          oninput: (ev) => { m.networkKey = ev.target.value; },
        }),
        h("button", { type: "button", class: `btn${networkPassed ? "" : " primary"}`, disabled: !!m.busy, onclick: runNetworkCheck },
          m.busy === "network" ? "检查中…" : networkPassed ? "重新检查" : "检查网络")),
      netReport ? h("dl", { class: "kv rt-auth-kv" },
        h("dt", {}, "出口国家"), h("dd", {}, netReport.exit?.countryCode || "未确认"),
        ...Object.entries(netLabels).flatMap(([k, lbl]) => {
          const st2 = netReport.checks?.[k]?.status;
          return [h("dt", {}, lbl), h("dd", { class: st2 === "passed" ? "rt-auth-ok" : "warn-text" }, st2 === "passed" ? (k === "networkType" ? "非机房" : "通过") : st2 === "failed" ? "未通过" : "无法确认")];
        })) : h("p", { class: "muted small" }, "核对出口地区与非机房类型后再安装组件或发起官方登录。")));
    stepNo++;
  }

  if (cap.managedInstall) {
    steps.push(h("section", { class: `rt-auth-step${installed ? " is-done" : networkPassed ? " is-active" : " is-locked"}` },
      h("div", { class: "rt-auth-step-head" },
        h("span", { class: "rt-auth-num" }, installed ? "✓" : String(stepNo)),
        h("h3", {}, `安装 ${RT_SHORT[kind]} 组件`),
        badge(installed ? "已安装" : "待安装", installed ? "ok" : "warn")),
      installed
        ? h("p", { class: "muted small" }, "组件已安装到实例私有目录并通过校验，不会影响宿主机全局配置。")
        : [
            h("p", { class: "muted small" }, "自动下载并校验哈希后安装到实例隔离目录，装完即可启用，无需重启服务。"),
            h("div", { class: "rt-auth-actions" },
              h("button", { type: "button", class: "btn primary", disabled: !!m.busy || !networkPassed, onclick: runInstall },
                m.busy === "install" ? "正在安装组件…" : `安装 ${RT_SHORT[kind]} 组件`)),
          ]));
    stepNo++;
  }

  // 登录步骤
  const loginReady = networkPassed && installed;
  const needsCode = flow && (flow.mode === "code-paste" || flow.mode === "hybrid");
  steps.push(h("section", { class: `rt-auth-step${succeeded ? " is-done" : loginReady ? " is-active" : " is-locked"}` },
    h("div", { class: "rt-auth-step-head" },
      h("span", { class: "rt-auth-num" }, succeeded ? "✓" : String(stepNo)),
      h("h3", {}, kind === "pi" ? "配置 API Key" : "网页官方登录"),
      badge(succeeded ? "已连接" : flowRunning ? "进行中" : "待完成", succeeded ? "ok" : flowRunning ? "accent" : "warn")),
    succeeded
      ? h("div", { class: "rt-auth-success" },
          h("strong", {}, `✓ ${RT_KIND[kind]} 已连接就绪`),
          h("p", { class: "small" }, [flow.identitySummary, flow.modelCount ? `检测到 ${flow.modelCount} 个可用模型` : ""].filter(Boolean).join(" · ") || "账号验证已通过，可以立即新建会话。"))
      : kind === "pi"
        ? h("form", { class: "rt-auth-form", onsubmit: submitPiKey },
            h("p", { class: "muted small" }, meta.hint),
            h("div", { class: "rt-auth-row" },
              h("select", { "aria-label": "模型服务商", value: m.apiProvider, disabled: !!m.busy, onchange: (ev) => { m.apiProvider = ev.target.value; } },
                h("option", { value: "deepseek", selected: m.apiProvider === "deepseek" }, "DeepSeek")),
              h("input", {
                type: "password", autocomplete: "off", placeholder: "输入你的 API Key",
                "aria-label": "API Key", "data-key": "rt-auth-pi-key",
                value: m.apiKey, disabled: !!m.busy,
                oninput: (ev) => { m.apiKey = ev.target.value; const btn = document.querySelector("[data-key='rt-auth-pi-submit']"); if (btn) btn.disabled = !!m.busy || !m.apiKey.trim(); },
              }),
              h("button", { type: "submit", class: "btn primary", "data-key": "rt-auth-pi-submit", disabled: !!m.busy || !m.apiKey.trim() }, m.busy === "submit" ? "验证中…" : "验证并保存")))
        : !flowRunning
          ? [
              h("p", { class: "muted small" }, meta.hint),
              !cap.installed && !cap.managedInstall
                ? h("p", { class: "warn-text small" }, `当前机器尚未检测到 ${RT_KIND[kind]} 可执行文件。`)
                : null,
              h("div", { class: "rt-auth-actions" },
                h("button", { type: "button", class: "btn primary", "data-key": "rt-auth-start", disabled: !!m.busy || !loginReady || (!cap.installed && !cap.managedInstall), onclick: startLogin },
                  m.busy === "start" ? "正在准备链接…" : "开始官方登录"),
                profile?.state === "needs-login" || profile?.lastAuthFailure
                  ? h("button", { type: "button", class: "btn", disabled: !!m.busy, onclick: verifyNow }, m.busy === "verify" ? "检查中…" : "已登录？立即检查")
                  : null),
            ]
          : [
              h("div", { class: "rt-auth-live", role: "status" },
                h("span", { class: "rt-auth-pulse", "aria-hidden": "true" }),
                h("span", {}, flow.phase === "verifying" ? "授权已收到，正在验证账号与模型…" : flow.phase === "submitting" ? "正在提交授权回执…" : "等待你在浏览器完成官方授权…")),
              h("p", { class: "muted small" }, flow.message),
              flow.authUrl ? h("div", { class: "rt-auth-actions" },
                h("a", { class: "btn primary", href: flow.authUrl, target: "_blank", rel: "noopener noreferrer" }, "打开官方登录页 ↗"),
                h("button", { type: "button", class: "btn", onclick: copyAuthUrl }, m.copied ? "✓ 已复制链接" : "复制登录链接"),
                h("button", { type: "button", class: "btn", disabled: !!m.busy, onclick: cancelFlow }, "取消")) : null,
              needsCode ? h("form", { class: "rt-auth-code-form", onsubmit: submitCode },
                h("label", { class: "small muted", for: "rt-auth-code-input" }, flow.mode === "code-paste" ? "授权完成后，粘贴授权码或回调网址：" : "若页面给出授权码请粘贴到这里（自动完成时无需填写）："),
                h("div", { class: "rt-auth-row" },
                  h("input", {
                    id: "rt-auth-code-input", type: "text", autocomplete: "off", spellcheck: "false",
                    placeholder: meta.codePlaceholder || "粘贴授权码", "data-key": "rt-auth-code",
                    value: m.code, disabled: !!m.busy || flow.phase === "verifying",
                    oninput: (ev) => { m.code = ev.target.value; const btn = document.querySelector("[data-key='rt-auth-code-submit']"); if (btn) btn.disabled = !!m.busy || !m.code.trim(); },
                  }),
                  h("button", { type: "submit", class: "btn primary", "data-key": "rt-auth-code-submit", disabled: !!m.busy || !m.code.trim() || flow.phase === "verifying" }, m.busy === "submit" ? "提交中…" : "提交"))) : null,
              h("div", { class: "rt-auth-fallback" },
                h("button", { type: "button", class: "btn-link small", disabled: !!m.busy, onclick: verifyNow }, m.busy === "verify" ? "检查中…" : "已完成浏览器授权？立即检查连接")),
            ]));

  return h("div", {
    class: "rt-auth-overlay",
    role: "presentation",
    onclick: (ev) => { if (ev.target === ev.currentTarget) void rtCloseAuthModal(false); },
    onkeydown: (ev) => { if (ev.key === "Escape") void rtCloseAuthModal(false); },
  },
    h("div", { class: "rt-auth-dialog", role: "dialog", "aria-modal": "true", "aria-label": `连接 ${RT_KIND[kind]}` },
      h("header", { class: "rt-auth-head" },
        h("div", { class: "rt-auth-title" },
          h("span", { class: `rt-glyph ${kind}`, "aria-hidden": "true" }, RT_GLYPH[kind]),
          h("div", {},
            h("h2", {}, `连接 ${meta.title}`),
            h("p", { class: "muted small" }, cap.isolatedCredentials ? "实例强隔离凭据 · 仅本机 127.0.0.1 可操作" : "网页托管官方授权 · 仅本机 127.0.0.1 可操作"))),
        h("button", { type: "button", class: "btn small rt-auth-close", "aria-label": "关闭", onclick: () => void rtCloseAuthModal(false) }, "✕")),
      h("div", { class: "rt-auth-body" },
        m.error ? h("p", { class: "field-error", role: "alert" }, m.error) : null,
        steps),
      h("footer", { class: "rt-auth-foot" },
        succeeded
          ? h("button", { type: "button", class: "btn primary", onclick: () => void rtCloseAuthModal(false) }, "完成并返回")
          : h("button", { type: "button", class: "btn", onclick: () => void rtCloseAuthModal(true) }, flowRunning ? "取消登录并关闭" : "关闭"))));
}

/* ------------------------------ 运行时配置 ------------------------------ */

const RT_CONFIG_TABS = [
  ["profiles", "rt-sec-profiles", "运行时"],
  ["settings", "rt-sec-settings", "设置与授权"],
  ["usage", "rt-sec-usage", "用量"],
  ["history", "rt-sec-history", "本机历史"],
];

/**
 * 运行时配置面板。options.embedded 用在系统设置的「运行时配置」一行：
 * 设置页已经有自己的标题和返回，这里不再重复一个标题层级与「← 返回会话」。
 * 手机端（≤760px）顶部 4 个子 Tab 分页切换；桌面端平铺各区块并用同一个导航条锚点跳转。
 */
function renderRuntimes(options = {}) {
  const embedded = options.embedded === true;
  const a = ui.rt.access;
  if (a?.canEditSettings && !ui.rt.authCaps && !ui.rt.authCapsLoading) void rtLoadAuthCaps();
  if (ui.rt.pendingAuthKind && a?.canEditSettings) {
    const targetKind = ui.rt.pendingAuthKind;
    ui.rt.pendingAuthKind = null;
    queueMicrotask(() => rtOpenAuthModal(targetKind));
  }
  const profiles = ui.rt.profiles;
  const probingAll = ui.rt.busy === "probe-all";
  const activeTab = RT_CONFIG_TABS.some(([k]) => k === ui.rt.configTab) ? ui.rt.configTab : "profiles";
  const probeAll = async () => {
    ui.rt.busy = "probe-all"; ui.rt.error = ""; renderMain();
    const results = await Promise.allSettled(RT_KINDS.map((k) => api(`/api/runtime-profiles/${k}/probe`, { method: "POST", body: "{}" })));
    const failed = results.map((r, i) => r.status === "rejected" ? `${RT_KIND[RT_KINDS[i]]}：${r.reason.message}` : null).filter(Boolean);
    if (failed.length) ui.rt.error = failed.join("；");
    await rtLoadProfiles().catch(() => {});
    announce(failed.length ? "部分运行时检查失败" : "全部运行时检查完成");
    ui.rt.busy = ""; renderMain();
  };
  const jump = (key, id, label) => {
    const on = activeTab === key;
    return h("a", {
      href: embedded ? "#/settings/runtimes" : "#/runtimes",
      role: "tab",
      class: `rt-config-tab${on ? " active on" : ""}`,
      "aria-selected": String(on),
      "data-rt-tab": key,
      onclick: (ev) => {
        ev.preventDefault();
        ui.rt.configTab = key;
        renderMain();
        if (!window.matchMedia?.("(max-width: 760px)").matches) {
          document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      },
    }, label);
  };
  const summary = `主机 ${ui.rt.host ? ui.rt.host.label : "本机"} · 认证由各 runtime 自己维护，平台只读脱敏身份摘要 · 检查连接不执行模型任务`;
  const probeAllBtn = a && a.control ? h("button", { type: "button", class: "btn", disabled: !!ui.rt.busy, onclick: probeAll }, probingAll ? "检查中…" : "全部检查") : null;
  return h("div", { class: `rt-config${embedded ? " rt-config-embedded" : ""}`, "data-rt-config-tab": activeTab },
    embedded ? null : h("p", { class: "rt-config-back" }, h("a", { href: "#/rt" }, "← 返回会话")),
    embedded
      ? h("div", { class: "rt-config-head" }, h("div", {}, h("p", { class: "muted small" }, summary)), probeAllBtn)
      : h("div", { class: "rt-config-head" },
          h("div", {}, h("h1", {}, "运行时"), h("p", { class: "muted small" }, summary)),
          probeAllBtn),
    h("nav", { class: "rt-config-nav inpage-tabs", role: "tablist", "aria-label": "页内导航" }, RT_CONFIG_TABS.map(([k, id, label]) => jump(k, id, label))),
    rtAccessNote(),
    ui.rt.error ? h("p", { class: "field-error", role: "alert" }, ui.rt.error) : null,
    h("div", { class: "rt-profiles rt-config-pane", id: "rt-sec-profiles", "data-rt-pane": "profiles", "data-rt-pane-active": String(activeTab === "profiles") },
      RT_KINDS.map((k) => rtProfileCard(k, profiles ? profiles.find((p) => p.runtimeKind === k) : null, a))),
    rtSettingsCard(a, activeTab === "settings"),
    rtUsageCard(activeTab === "usage"),
    rtHistoryCard(a, activeTab === "history"),
    rtAuthModal());
}

function rtProfileDefaultPermission(kind, p) {
  const options = p?.permissionOptions?.length ? p.permissionOptions : (p?.permissions ? [p.permissions] : []);
  const saved = ui.rt.settings?.defaultSessionByRuntime?.[kind]?.permissionMode;
  const builtin = typeof rtDefaultPermission === "function" ? rtDefaultPermission(kind) : (p?.permissions?.id || options[0]?.id || "");
  const activeId = (saved && options.some((x) => x.id === saved)) ? saved : (options.some((x) => x.id === builtin) ? builtin : (options[0]?.id || builtin));
  const active = options.find((x) => x.id === activeId) || p?.permissions || { id: activeId, label: activeId || "默认", detail: "" };
  return { options, activeId, active, saved: saved || "" };
}

function rtProfileCard(kind, p, a) {
  const probing = ui.rt.busy === `probe-${kind}` || ui.rt.busy === "probe-all";
  const permBusy = ui.rt.busy === `perm-${kind}`;
  const probe = async (relogged) => {
    ui.rt.busy = `probe-${kind}`; ui.rt.error = ""; renderMain();
    try { await api(`/api/runtime-profiles/${kind}/probe`, { method: "POST", body: JSON.stringify(relogged === true ? { reloggedIn: true } : {}) }); await rtLoadProfiles(); announce(`${RT_KIND[kind]} 检查完成`); }
    catch (e) { ui.rt.error = `${RT_KIND[kind]}：${e.message}`; }
    ui.rt.busy = ""; renderMain();
  };
  const refreshRl = async () => {
    ui.rt.busy = `rl-${kind}`; renderMain();
    try { await api(`/api/runtime-profiles/${kind}/rate-limits`, { method: "POST", body: "{}" }); await rtLoadProfiles(); }
    catch (e) { ui.rt.error = `${RT_KIND[kind]} 额度：${e.message}`; }
    ui.rt.busy = ""; renderMain();
  };
  const perm = p ? rtProfileDefaultPermission(kind, p) : null;
  const savePerm = async (nextMode) => {
    if (!p || !perm) return;
    const cur = ui.rt.settings?.defaultSessionByRuntime?.[kind];
    const sel = typeof rtSelectableModels === "function" ? rtSelectableModels(kind, p) : { models: p.models || [] };
    let model = cur?.model ?? "";
    let effort = cur?.effort ?? "";
    if (model && !sel.models.some((m) => m.id === model)) { model = ""; effort = ""; }
    if (effort) {
      const mo = typeof rtModelOption === "function" ? rtModelOption(p, model) : p.models?.find((m) => m.id === model);
      if (!(mo?.efforts || []).includes(effort)) effort = "";
    }
    ui.rt.busy = `perm-${kind}`; ui.rt.error = ""; renderMain();
    try {
      ui.rt.settings = await api(`/api/runtime-profiles/${kind}/session-defaults`, {
        method: "PUT",
        body: JSON.stringify({ defaults: { model, effort, permissionMode: nextMode } }),
      });
      if (ui.rt.settingsDraft) ui.rt.settingsDraft.defaultSessionByRuntime = ui.rt.settings.defaultSessionByRuntime;
      if (typeof rtWriteCache === "function") rtWriteCache();
      const label = perm.options.find((x) => x.id === nextMode)?.label || nextMode;
      announce(`${RT_KIND[kind]} 默认权限已改为 ${label}`);
    } catch (e) {
      ui.rt.error = `${RT_KIND[kind]} 默认权限：${e.message}`;
    }
    ui.rt.busy = ""; renderMain();
  };
  const [st, sk] = p ? RT_PROFILE_STATE[p.state] || [p.state, ""] : ["未检查", "warn"];
  const channel = p ? (p.transport === "app-server-stdio" ? "Codex app-server（stdio，平台自管进程）" : p.transport === "pi-rpc" ? "Pi RPC（本地进程）" : p.transport === "acp-stdio" ? "Antigravity ACP（stdio，本地进程）" : "Claude Agent SDK（本地进程）") : "";
  const authCaps = ui.rt.authCaps;
  const authCap = authCaps?.available ? authCaps.runtimes?.[kind] : null;
  const canVisualAuth = !!(a && a.canEditSettings && authCap);
  const needsInstall = !!(authCap?.managedInstall && !authCap.installed);
  const needsLogin = !p || p.state === "needs-login" || p.state === "not-installed" || !!p.lastAuthFailure;
  const visualAuthLabel = needsInstall
    ? "启用并连接"
    : kind === "pi"
      ? (p?.state === "executable" ? "更换 Key" : "配置 API Key")
      : (p?.state === "executable" && !p?.lastAuthFailure ? "重新登录" : "网页登录");
  const visualAuthPrimary = needsInstall || needsLogin;
  const friendlyReason = (() => {
    if (!p) return "";
    if (canVisualAuth && needsInstall && p.state === "not-installed") {
      return "尚未启用此运行时，点击「启用并连接」可在界面中完成网络检查、组件安装与官方登录。";
    }
    if (canVisualAuth && (p.state === "needs-login" || p.lastAuthFailure)) {
      return kind === "pi"
        ? "尚未配置可用的模型 API Key，点击「配置 API Key」即可验证并隔离保存。"
        : "尚未登录或登录已过期，点击「网页登录」即可在浏览器完成官方授权，无需打开终端。";
    }
    return p.stateReason;
  })();
  return h("section", { class: "card rt-profile", "aria-label": RT_KIND[kind] },
    h("div", { class: "rt-profile-head" }, h("span", { class: `rt-glyph ${kind}`, "aria-hidden": "true" }, RT_GLYPH[kind]), h("h2", {}, RT_KIND[kind]), badge(st, sk),
      a && a.control ? h("button", { type: "button", class: "btn small", disabled: probing || !!ui.rt.busy, onclick: () => probe(false) }, probing ? "检查中…" : "检查") : null),
    !p ? [
      h("p", { class: "muted small" }, canVisualAuth ? "还没有检查过。可以直接在网页完成连接与授权，或先点「检查」核对当前状态。" : "还没有检查过。检查会在服务进程环境里查找 runtime、核对协议能力与登录状态，不执行模型任务。"),
      canVisualAuth ? h("div", { class: "rt-profile-cta" },
        h("button", { type: "button", class: `btn small${visualAuthPrimary ? " primary" : ""}`, "data-key": `rt-visual-auth-${kind}`, disabled: !!ui.rt.busy, onclick: () => rtOpenAuthModal(kind) }, visualAuthLabel)) : null,
    ] : [
      h("p", { class: `rt-profile-reason small${sk === "ok" ? " muted" : " warn-text"}` }, friendlyReason),
      canVisualAuth ? h("div", { class: "rt-profile-cta" },
        h("button", { type: "button", class: `btn small${visualAuthPrimary ? " primary" : ""}`, "data-key": `rt-visual-auth-${kind}`, disabled: !!ui.rt.busy, onclick: () => rtOpenAuthModal(kind) }, visualAuthLabel)) : null,
      a && a.control && p.lastAuthFailure && !canVisualAuth ? h("button", { type: "button", class: "btn small primary", disabled: probing, onclick: () => probe(true) }, "已重新登录，重新检查") : null,
      rtQuotaWarning(p),
      h("dl", { class: "kv rt-facts" },
        h("dt", {}, "账号"), h("dd", { title: p.identity ? `${p.identity.authMode} · 来源 ${p.identity.source}` : "" }, p.identity ? p.identity.summary : "未知"),
        h("dt", {}, "版本"), h("dd", {}, `${p.binaryVersion || "未知"}${p.sdkVersion ? ` · SDK ${p.sdkVersion}` : ""}`),
        h("dt", {}, "默认权限"), h("dd", { class: "rt-default-perm" },
          a && a.control && perm.options.length > 1
            ? h("div", { class: "rt-default-perm-row" },
                h("select", {
                  class: "rt-default-perm-select",
                  "aria-label": `${RT_KIND[kind]} 默认权限`,
                  "data-key": `rt-default-perm-${kind}`,
                  disabled: permBusy || !!ui.rt.busy,
                  onchange: (ev) => savePerm(ev.target.value),
                }, perm.options.map((opt) => h("option", { value: opt.id, selected: opt.id === perm.activeId }, opt.label))),
                permBusy ? h("span", { class: "muted small" }, "保存中…") : null)
            : h("span", { title: perm.active.detail }, perm.active.label),
          perm.active.detail ? h("span", { class: `rt-default-perm-note small${perm.activeId === "full-access" || perm.activeId === "bypassPermissions" ? " warn-text" : " muted"}` }, perm.active.detail) : null),
        h("dt", {}, "检查"), h("dd", { title: rtTime(p.checkedAt) }, rtAgo(p.checkedAt))),
      h("div", { class: "rt-profile-sec" }, p.models.length ? rtModelAllowlist(kind, p, a) : [h("h3", {}, "模型"), h("p", { class: "muted small" }, "未读取到")]),
      h("div", { class: "rt-profile-sec rt-rl" },
        h("div", { class: "rt-sec-head" }, h("h3", {}, "账户额度"),
          a && a.control && p.identity ? h("button", { type: "button", class: "btn-link small", disabled: ui.rt.busy === `rl-${kind}`, onclick: refreshRl }, ui.rt.busy === `rl-${kind}` ? "读取中…" : "刷新") : null),
        rtQuotaContent(kind, p.rateLimit)),
      h("details", { class: "rt-profile-more" }, h("summary", { class: "small" }, "详情：位置、通道、能力与生效配置"),
        h("dl", { class: "kv rt-facts" },
          h("dt", {}, "位置"), h("dd", { class: "mono small" }, p.binaryPath || "—"),
          h("dt", {}, "通道"), h("dd", { class: "small" }, channel),
          h("dt", {}, "身份"), h("dd", { class: "small" }, p.identity ? `${p.identity.authMode} · ${p.identity.derivation === "stable-account-id" ? "稳定账号 ID" : "持久身份分区（无稳定账号 ID）"} · 来源 ${p.identity.source}` : "未知"),
          h("dt", {}, "权限"), h("dd", { class: "small" }, perm.active.detail || p.permissions.detail),
          h("dt", {}, "检查于"), h("dd", { class: "small" }, rtTime(p.checkedAt))),
        h("table", { class: "rt-table rt-cap-table" }, h("tbody", {}, Object.entries(p.capabilities).map(([k, c2]) => h("tr", {},
          h("td", { class: "rt-cap-name" }, RT_CAP[k] || k), h("td", { class: "rt-cap-status" }, badge({ supported: "支持", unsupported: "不支持", unknown: "未知" }[c2.status] || c2.status, c2.status === "supported" ? "ok" : c2.status === "unsupported" ? "bad" : "warn")),
          h("td", { class: "rt-cap-reason small muted" }, c2.reason))))),
        p.configSummary?.length ? h("ul", { class: "small" }, p.configSummary.map((l) => h("li", {}, l))) : null)
    ]);
}

/**
 * 新建会话可选的模型：平时只显示摘要（可选几个、默认是哪个），点"编辑"才展开勾选列表。
 * 跟着控制权限走：对外入口开了控制也能改（只在 runtime 报告的模型里收窄或放开）。
 */
function rtModelAllowlist(kind, p, a) {
  const saved = ui.rt.settings?.enabledModelsByRuntime?.[kind];
  const drafts = ui.rt.modelDrafts || (ui.rt.modelDrafts = {});
  const editing = ui.rt.modelEditing || (ui.rt.modelEditing = {});
  const allIds = p.models.map((m) => m.id);
  const savedIds = saved ? saved.filter((id) => allIds.includes(id)) : allIds;
  const current = drafts[kind] || savedIds;
  const editable = !!(a && a.control);
  const busy = ui.rt.busy === `models-${kind}`;
  const def = p.models.find((m) => m.isDefault);
  const close = () => { delete drafts[kind]; editing[kind] = false; renderMain(); };
  const save = async (value) => {
    ui.rt.busy = `models-${kind}`; ui.rt.error = ""; renderMain();
    try {
      ui.rt.settings = await api(`/api/runtime-profiles/${kind}/models`, { method: "PUT", body: JSON.stringify({ models: value }) });
      if (ui.rt.settingsDraft) ui.rt.settingsDraft.enabledModelsByRuntime = ui.rt.settings.enabledModelsByRuntime;
      delete drafts[kind]; editing[kind] = false; announce(`${RT_KIND[kind]} 可选模型已保存`);
    } catch (e) { ui.rt.error = `${RT_KIND[kind]} 可选模型：${e.message}`; }
    ui.rt.busy = ""; renderMain();
  };
  const head = h("div", { class: "rt-sec-head" },
    h("h3", {}, "模型"),
    h("span", { class: "muted small" }, saved ? `可选 ${savedIds.length} / ${allIds.length}` : `全部 ${allIds.length} 个可选`),
    editable && !editing[kind] ? h("button", { type: "button", class: "btn-link small", "data-key": `rt-models-edit-${kind}`, onclick: () => { editing[kind] = true; renderMain(); } }, "编辑") : null);
  if (!editing[kind]) {
    const shownIds = saved ? savedIds : (def ? [def.id] : []);
    const chips = p.models.filter((m) => shownIds.includes(m.id));
    const LIMIT = 6;
    return h("div", { class: "rt-model-allow" }, head,
      h("div", { class: "rt-chips" },
        chips.slice(0, LIMIT).map((m) => h("span", { class: `rt-chip${m.isDefault ? " default" : ""}`, title: m.id }, m.label, m.isDefault ? h("span", { class: "rt-chip-tag" }, "默认") : null)),
        chips.length > LIMIT ? h("span", { class: "rt-chip more", title: chips.slice(LIMIT).map((m) => m.label).join("、") }, `+${chips.length - LIMIT}`) : null,
        !saved ? h("span", { class: "muted small" }, def ? "等全部模型" : "未限定") : null),
      saved && def && !saved.includes(def.id) ? h("p", { class: "muted small" }, `默认模型 ${def.label} 未勾选：新建会话会预选第一个可选模型。`) : null);
  }
  const toggle = (id, on) => { drafts[kind] = allIds.filter((x) => on ? x === id || current.includes(x) : x !== id && current.includes(x)); renderMain(); };
  const filters = ui.rt.modelFilter || (ui.rt.modelFilter = {});
  const q = (filters[kind] || "").trim().toLowerCase();
  const many = p.models.length > 12;
  // 已限定时把已保存勾选的排在前面（按保存的值排，勾选过程中不跳动）
  const ordered = saved ? [...p.models.filter((m) => saved.includes(m.id)), ...p.models.filter((m) => !saved.includes(m.id))] : p.models;
  const shown = q ? ordered.filter((m) => `${m.id} ${m.label}`.toLowerCase().includes(q)) : ordered;
  const setMany = (on) => { const ids = new Set(shown.map((m) => m.id)); drafts[kind] = allIds.filter((x) => on ? ids.has(x) || current.includes(x) : current.includes(x) && !ids.has(x)); renderMain(); };
  const dirty = !!drafts[kind] && JSON.stringify(drafts[kind]) !== JSON.stringify(savedIds);
  return h("div", { class: "rt-model-allow editing" }, head,
    h("p", { class: "muted small" }, "新建会话只能选择勾选的模型；项目里的角色会话不受影响。"),
    h("div", { class: "rt-model-tools" },
      many ? h("input", { type: "search", "aria-label": `筛选 ${RT_KIND[kind]} 模型`, "data-key": `rt-model-q-${kind}`, placeholder: `筛选 ${allIds.length} 个模型…`, value: filters[kind] || "", oninput: (ev) => { filters[kind] = ev.target.value; renderMain(); } }) : null,
      h("button", { type: "button", class: "btn-link small", disabled: busy || !shown.length, onclick: () => setMany(true) }, q ? "勾选筛选结果" : "全选"),
      h("button", { type: "button", class: "btn-link small", disabled: busy || !shown.length, onclick: () => setMany(false) }, q ? "取消筛选结果" : "全不选"),
      h("span", { class: "muted small rt-model-count" }, `已选 ${current.length}`)),
    h("div", { class: "rt-model-list", "data-keep-scroll": `rt-models-${kind}` },
      shown.length ? shown.map((m) => h("label", { class: "rt-check", title: m.id },
        h("input", { type: "checkbox", "data-key": `rt-model-${kind}-${m.id}`, disabled: busy, checked: current.includes(m.id), onchange: (ev) => toggle(m.id, ev.target.checked) }),
        h("span", { class: "rt-check-label" }, m.label), m.isDefault ? h("span", { class: "rt-chip-tag" }, "默认") : null)) : h("p", { class: "muted small" }, "没有匹配的模型")),
    h("div", { class: "rt-actions" },
      h("button", { type: "button", class: "btn small primary", disabled: busy || !current.length || !dirty, onclick: () => save(current.length === allIds.length && !saved ? null : current) }, busy ? "保存中…" : "保存"),
      h("button", { type: "button", class: "btn small", disabled: busy, onclick: close }, "取消"),
      saved ? h("button", { type: "button", class: "btn-link small", disabled: busy, onclick: () => save(null) }, "恢复全部可选") : null,
      !current.length ? h("span", { class: "field-error small" }, "至少勾选一个模型") : null));
}

/** 本机已有历史（只读）：从多运行时对话列表里剥离出来，在这里按工作目录查看 */
function rtHistoryCard(a, active = true) {
  const hist = ui.rt.history;
  const load = async () => {
    ui.rt.history = { loading: true };
    renderMain();
    try { const d = await api("/api/session-directory?source=readonly&limit=200"); ui.rt.history = { entries: d.entries || [], total: d.total || 0, notes: d.history || {} }; }
    catch (e) { ui.rt.history = { error: e.message }; }
    renderMain();
  };
  const notes = hist && hist.notes ? Object.entries(hist.notes).filter(([, x]) => x.error || (x.notes && x.notes.length)).map(([k, x]) => `${RT_KIND[k]}：${x.error || x.notes.join("；")}`) : [];
  return h("section", { class: "card rt-history-card rt-config-pane", id: "rt-sec-history", "data-rt-pane": "history", "data-rt-pane-active": String(active) },
    h("div", { class: "rt-profile-head" }, h("h2", {}, "本机历史（只读）"),
      a && !a.history ? null : h("button", { type: "button", class: "btn small", disabled: !!(hist && hist.loading), onclick: load }, hist && hist.entries ? "刷新" : "查看历史会话")),
    h("p", { class: "muted small" }, "授权目录里 Codex / Claude Code / Pi / Antigravity 已有的本机会话，只能查看，不能续聊。授权范围在上方「设置与授权」里调整。"),
    a && !a.history ? h("p", { class: "muted small" }, "当前入口没有开启历史查看") : null,
    !hist ? null : hist.loading ? h("p", { class: "muted small" }, "加载中…") : hist.error ? h("p", { class: "field-error" }, hist.error) : [
      notes.length ? h("p", { class: "muted small" }, notes.join("；")) : null,
      !hist.entries.length ? h("p", { class: "muted small" }, "没有可查看的历史。先在设置里授权目录。") : rtGroupByWorkspace(hist.entries).map((g) => h("details", { class: "rt-hist-group", open: !!(ui.rt.historyOpen || {})[g.key], ontoggle: (ev) => { (ui.rt.historyOpen ||= {})[g.key] = ev.currentTarget.open; } },
        h("summary", { title: g.path }, h("span", { class: "rt-group-name" }, g.label), h("span", { class: "rt-group-count" }, String(g.entries.length))),
        h("ul", { class: "rt-ul" }, g.entries.map((e) => h("li", {}, h("a", { class: "rt-item", href: e.href },
          rtAvatar(e.runtimeKind, e.model),
          h("span", { class: "rt-item-main" },
            h("span", { class: "rt-item-top" }, h("span", { class: "rt-item-title" }, e.title), h("time", { class: "rt-item-time" }, rtAgo(e.lastActivityAt))),
            h("span", { class: "rt-item-sub" }, h("span", { class: "rt-item-model" }, rtModelShort(e.model) || RT_KIND[e.runtimeKind]))))))))),
      hist.total > hist.entries.length ? h("p", { class: "muted small" }, `共 ${hist.total} 项，显示最近 ${hist.entries.length} 项`) : null
    ]);
}

function rtUsageCard(active = true) {
  const u = ui.rt.usageSummary;
  const fmt = (x) => x ? `${rtNum(x.input)} / ${rtNum(x.output)}（${x.requests} 次）` : "—";
  const cell = (label, x) => h("td", { "data-label": label, ...(x ? {} : { "data-empty": "true" }) }, fmt(x));
  return h("section", { class: "card rt-usage-card rt-config-pane", id: "rt-sec-usage", "data-rt-pane": "usage", "data-rt-pane-active": String(active) },
    h("h2", {}, "用量汇总（近 14 天）"),
    !u ? h("p", { class: "muted small" }, ui.rt.usageError || "加载中…") : [
      u.days.length ? h("div", { class: "rt-table-wrap rt-usage-wrap", "data-keep-scroll-x": "rt-usage-table" }, h("table", { class: "rt-table rt-usage-table" },
        h("thead", {}, h("tr", {}, h("th", {}, `日期（${u.timeZone}）`), h("th", {}, "Claude Code 输入 / 输出"), h("th", {}, "Codex 输入 / 输出"), h("th", {}, "Pi 输入 / 输出"), h("th", {}, "Antigravity 输入 / 输出"))),
        h("tbody", {}, u.days.map((d) => {
          const any = RT_KINDS.some((k) => !!d.byRuntime[k]);
          return h("tr", { ...(any ? {} : { "data-all-empty": "true" }) },
            h("td", { class: "rt-usage-day" }, d.day),
            cell("Claude Code", d.byRuntime["claude-code"]),
            cell("Codex", d.byRuntime.codex),
            cell("Pi", d.byRuntime.pi),
            cell("Antigravity", d.byRuntime.antigravity));
        })))) : h("p", { class: "muted small" }, "这段时间没有可按日期归属的用量"),
      u.unattributed.length ? h("p", { class: "small" }, "不分日期（只有会话累计值）：", u.unattributed.map((x) => `${RT_KIND[x.runtimeKind]} ${x.sessions} 个会话，合计 ${rtNum(x.total)} tokens`).join("；")) : null,
      h("ul", { class: "muted small" }, u.notes.map((n) => h("li", {}, n)))
    ]);
}

const RT_HIST_NOTE = {
  codex: "经 Codex app-server 的 thread/list、thread/read 读取；历史用量从授权根内的 rollout 文件末尾回退读取。不读取认证文件或 Desktop 私有数据库。",
  "claude-code": "经 Claude Agent SDK 的 listSessions、getSessionMessages 读取。撤销授权清理平台缓存，不删除原文件。",
  pi: "只读解析授权项目的 Pi 原生会话记录；撤销授权清理平台索引，不删除原文件。",
  antigravity: "经 agy acp 的 session/list、session/load 读取；回放只含消息与工具调用，不含 token 用量。撤销授权清理平台缓存，不删除原文件。"
};

/**
 * 并发会话上限（共享账号同时调用上限）：有控制权限就能在对外入口直接改，不用回本机入口。
 * 调高要确认一次（同一账号同时跑更多会话，更容易撞上额度窗口）；调低直接生效，已在跑的不受影响。
 */
function rtMaxRunningPicker(s) {
  const cur = s.maxRunningPerProfile;
  return h("span", { class: "rt-maxrun" }, "每个共享账号同时 ",
    h("select", { "aria-label": "并发会话上限", disabled: ui.rt.busy === "max-running", onchange: async (ev) => {
      const next = Number(ev.target.value);
      if (next > cur && !confirm(`把并发会话上限从 ${cur} 提高到 ${next}？\n同一账号同时跑更多会话，更容易用满 5 小时 / 周额度。`)) { ev.target.value = String(cur); return; }
      ui.rt.busy = "max-running"; ui.rt.error = "";
      try { ui.rt.settings = await api("/api/runtime-settings/max-running", { method: "PUT", body: JSON.stringify({ maxRunningPerProfile: next }) }); rtWriteCache(); announce(`并发会话上限已改为 ${next}`); }
      catch (e) { ui.rt.error = `并发会话上限：${e.message}`; }
      ui.rt.busy = ""; renderMain();
    } }, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => h("option", { value: String(n), selected: n === cur }, String(n)))),
    " 个", ui.rt.busy === "max-running" ? h("span", { class: "muted" }, " 保存中…") : null);
}

function rtSettingsCard(a, active = true) {
  const s = ui.rt.settings;
  if (!s) return null;
  // 服务端总会给全部 runtime；快照缺某一项时补默认，不让一个缺项把整页设置画崩
  for (const k of RT_KINDS) (s.history ||= {})[k] ||= { enabled: false, roots: [] };
  const editable = a && a.canEditSettings;
  const own = (k, src) => src.workspaceRootsByRuntime && src.workspaceRootsByRuntime[k] != null;
  const paneAttrs = { class: "card rt-settings rt-config-pane", id: "rt-sec-settings", "data-rt-pane": "settings", "data-rt-pane-active": String(active) };
  if (!editable) {
    // 对外入口只读：直接给结论，不铺一页禁用的输入框
    const paths = (arr) => arr.length ? h("span", { class: "mono small" }, arr.join("、")) : h("span", { class: "muted small" }, "无");
    return h("section", paneAttrs,
      h("div", { class: "rt-sec-head" }, h("h2", {}, "设置与授权"), h("span", { class: "muted small" }, a && a.control ? "并发上限可以在这里改；其余只读，在本机入口（127.0.0.1）修改" : "只读 · 在本机入口（127.0.0.1）修改")),
      h("dl", { class: "kv rt-facts" },
        h("dt", {}, "目录根"), h("dd", { title: "允许新建会话的工作目录根" }, paths(s.workspaceRoots)),
        h("dt", {}, "对外入口"), h("dd", { class: "small" }, `查看${s.publicHistory ? "已开启" : "关闭"} · 控制${s.publicControl ? "已开启" : "关闭"}`),
        h("dt", {}, "并发上限"), h("dd", { class: "small" }, a && a.control ? rtMaxRunningPicker(s) : `每个共享账号同时 ${s.maxRunningPerProfile} 个`)),
      h("div", { class: "rt-settings-grid" }, RT_KINDS.map((k) => h("div", { class: "rt-settings-col" },
        h("h3", {}, h("span", { class: `rt-glyph ${k}`, "aria-hidden": "true" }, RT_GLYPH[k]), RT_KIND[k]),
        h("dl", { class: "kv rt-facts" },
          h("dt", {}, "工作目录"), h("dd", {}, own(k, s) ? (s.workspaceRootsByRuntime[k].length ? paths(s.workspaceRootsByRuntime[k]) : h("span", { class: "warn-text small" }, "禁止新建")) : h("span", { class: "muted small" }, "继承全局")),
          h("dt", {}, "历史授权"), h("dd", {}, s.history[k].enabled ? paths(s.history[k].roots) : h("span", { class: "muted small" }, "关闭")),
          k === "codex" && s.history[k].enabled && (s.history[k].originators || []).length ? [h("dt", {}, "创建方"), h("dd", { class: "small" }, s.history[k].originators.join("、"))] : null)))));
  }
  const d = ui.rt.settingsDraft || (ui.rt.settingsDraft = JSON.parse(JSON.stringify(s)));
  const lines = (arr) => arr.join("\n");
  const parse = (v) => v.split("\n").map((x) => x.trim()).filter(Boolean);
  // 可选模型在各运行时卡片里单独保存，这里不带上，免得用旧值覆盖
  const body = () => { const { enabledModelsByRuntime: _m, defaultSessionByRuntime: _d, updatedAt: _u, ...rest } = d; return rest; };
  const base = () => { const { enabledModelsByRuntime: _m, defaultSessionByRuntime: _d, updatedAt: _u, ...rest } = s; return rest; };
  const isDirty = () => JSON.stringify(body()) !== JSON.stringify(base());
  // 输入框只改草稿、不整页重绘；保存条按是否有改动显示
  const touched = () => { document.querySelector(".rt-savebar")?.classList.toggle("dirty", isDirty()); };
  const save = async () => {
    ui.rt.busy = "settings"; ui.rt.error = ""; renderMain();
    try { ui.rt.settings = await api("/api/runtime-settings", { method: "PUT", body: JSON.stringify(body()) }); ui.rt.settingsDraft = null; announce("设置已保存"); }
    catch (e) { ui.rt.error = `设置：${e.message}`; }
    ui.rt.busy = ""; renderMain();
  };
  const area = (key, value, oninput, extra = {}) => h("textarea", { rows: String(Math.min(4, Math.max(2, value.length + 1))), "data-key": key, value: lines(value), oninput: (ev) => { oninput(parse(ev.target.value)); touched(); }, ...extra });
  return h("section", paneAttrs,
    h("div", { class: "rt-sec-head" }, h("h2", {}, "设置与授权"), h("span", { class: "muted small" }, "只在本机入口可改")),
    h("div", { class: "rt-settings-top" },
      h("label", { class: "rt-field" }, "允许新建会话的工作目录根（每行一个绝对路径）",
        area("rt-set-ws", d.workspaceRoots, (v) => { d.workspaceRoots = v; })),
      h("div", { class: "rt-settings-side" },
        h("label", { class: "rt-check" }, h("input", { type: "checkbox", checked: d.publicHistory, onchange: (ev) => { d.publicHistory = ev.target.checked; touched(); } }), " 对外入口可查看外部会话"),
        h("label", { class: "rt-check" }, h("input", { type: "checkbox", checked: d.publicControl, onchange: (ev) => { d.publicControl = ev.target.checked; touched(); } }), " 对外入口可创建、续聊、停止与审批"),
        h("label", { class: "rt-check" }, "共享账号同时调用上限 ",
          h("select", { "aria-label": "共享账号同时调用上限", onchange: (ev) => { d.maxRunningPerProfile = Number(ev.target.value); touched(); } }, [1, 2, 3, 4, 5, 6, 7, 8].map((n) => h("option", { value: String(n), selected: d.maxRunningPerProfile === n }, String(n))))),
        h("p", { class: "muted small" }, "对外开启前确认：对外登录使用服务端会话（可过期、可单独吊销），且所有可达入口都经过登录或 Cloudflare Access。"))),
    h("div", { class: "rt-settings-grid" }, RT_KINDS.map((k) => h("fieldset", { class: "rt-settings-col" },
      h("legend", {}, h("span", { class: `rt-glyph ${k}`, "aria-hidden": "true" }, RT_GLYPH[k]), RT_KIND[k]),
      h("label", { class: "rt-check" }, h("input", { type: "checkbox", checked: own(k, d), onchange: (ev) => {
        if (!d.workspaceRootsByRuntime) d.workspaceRootsByRuntime = {};
        d.workspaceRootsByRuntime[k] = ev.target.checked ? [] : null;
        renderMain();
      } }), " 单独配置工作目录（空 = 禁止新建）"),
      own(k, d) ? area(`rt-set-ws-${k}`, d.workspaceRootsByRuntime[k], (v) => { d.workspaceRootsByRuntime[k] = v; }, { placeholder: "每行一个绝对路径；留空 = 禁止新建", "aria-label": `${RT_KIND[k]} 工作目录` })
        : h("p", { class: "muted small rt-inherit" }, "继承全局目录根"),
      h("label", { class: "rt-check", title: RT_HIST_NOTE[k] }, h("input", { type: "checkbox", checked: d.history[k].enabled, onchange: (ev) => { d.history[k].enabled = ev.target.checked; renderMain(); } }), " 允许只读这些目录里的历史会话"),
      d.history[k].enabled ? [
        area(`rt-set-h-${k}`, d.history[k].roots, (v) => { d.history[k].roots = v; }, { placeholder: "/Users/…/项目目录", "aria-label": `${RT_KIND[k]} 历史授权目录` }),
        k === "codex" ? area("rt-set-orig-codex", d.history[k].originators || [], (v) => { d.history[k].originators = v; }, { placeholder: "只读这些创建方，如 Codex Desktop（留空 = 不限）", "aria-label": "Codex 历史创建方" }) : null,
        h("p", { class: "muted small" }, RT_HIST_NOTE[k])] : null))),
    h("div", { class: `rt-savebar${isDirty() ? " dirty" : ""}` },
      h("span", { class: "small" }, "设置有未保存的修改"),
      h("button", { type: "button", class: "btn primary", disabled: ui.rt.busy === "settings", onclick: save }, ui.rt.busy === "settings" ? "保存中…" : "保存设置"),
      h("button", { type: "button", class: "btn", onclick: () => { ui.rt.settingsDraft = null; renderMain(); } }, "放弃修改")));
}

// Definitions only; the active route owns reads and rendering.
globalThis.piRouteModules?.register("runtimes", { render: () => renderRuntimes() });
// 系统设置（#/settings/runtimes）把同一份内容嵌在设置页里。
globalThis.rtRuntimesPanel = () => renderRuntimes({ embedded: true });
