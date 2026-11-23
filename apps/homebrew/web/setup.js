'use strict';
const names = ['检查环境', '本机设置', '连接账号', '首次任务', '完成'];
const panel = document.querySelector('#panel');
let step = 0, state, password = '', confirmation = '', apiKey = '', models = [], selectedModel = '', working = false, message = '', poll;
let runtimeKind = 'pi', networkApiKey = '', networkResult, loginFlow = null, authCode = '', copiedUrl = false, showNetworkRecheck = false;
const RUNTIME_META = {
  pi: { label: 'API Key', title: '模型账号', hint: '填写 DeepSeek API Key，直连官方校验，不经第三方服务器。' },
  codex: { label: 'Codex', title: 'Codex', hint: '在浏览器打开 OpenAI 官方页授权，完成后自动回传并校验。' },
  'claude-code': { label: 'Claude Code', title: 'Claude Code', hint: '在浏览器打开 Claude 官方页登录，支持自动回传或粘贴页面授权码。' },
  antigravity: { label: 'Antigravity', title: 'Antigravity（Google AI Pro）', hint: '在浏览器用 Google 账号授权后，把回调页显示的授权码或完整网址粘贴到这里。' }
};
const optional = () => runtimeKind !== 'pi';
const choices = () => `<div class="runtime-choices" role="group" aria-label="账号类型">${['pi', 'codex', 'claude-code', 'antigravity'].map(id => `<button type="button" data-runtime="${id}" aria-pressed="${runtimeKind === id}" ${state?.configured || working ? 'disabled' : ''}>${RUNTIME_META[id].label}</button>`).join('')}</div>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
async function api(path, body, authorization) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(authorization ? { authorization } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw Error(result.error || '操作未完成'); return result;
}
function actions(back, next, disabled = false) { return `<div class="actions">${back ? `<button id="back" type="button" ${working ? 'disabled' : ''}>上一步</button>` : '<span>仅在你的 Mac 上设置</span>'}<button class="primary" id="next" ${disabled || working ? 'disabled' : ''}>${working ? '正在处理…' : next}</button></div>`; }
function notice() { return message ? `<p class="error" role="alert">${escape(message)}</p>` : '<p class="error" role="alert"></p>'; }

function networkSummaryHtml() {
  const report = networkResult?.report, decision = networkResult?.decision;
  const labels = { region: '支持地区', connectivity: '官方服务连通性', networkType: 'IP 类型' };
  const failures = {
    'classification-unavailable': '当前响应缺少机房分类。请填写自己的 ipapi.is Key 后重新检查。',
    'rate-limited': '检测额度已用完，请稍后重试。',
    'exit-changed': '检查期间出口发生变化，请重新检查。',
    'ip-mismatch': '两次查询的 IP 不一致，请检查网络。',
    'lookup-unavailable': '无法完成检测，请检查网络后重试。'
  };
  if (!report) return '';
  return `<div class="rows compact" role="status"><div class="row"><span>出口国家</span><span>${escape(report.exit?.countryCode || '未确认')}</span></div>${Object.entries(labels).map(([id, label]) => `<div class="row"><span>${label}</span><span class="${report.checks[id]?.status === 'passed' ? 'ok' : 'error'}">${report.checks[id]?.status === 'passed' ? id === 'networkType' ? '非机房' : '通过' : report.checks[id]?.status === 'failed' ? '未通过' : '无法确认'}</span></div>`).join('')}</div><p class="hint">${decision?.allowed ? '本次网络检查通过；安装、登录和首次任务前仍会实时复核。' : escape(failures[networkResult.failure] || '网络检查未通过，安装和登录已停止。')}</p>`;
}

function loginSectionHtml(configured, component, connected) {
  const meta = RUNTIME_META[runtimeKind];
  if (!configured || !component) {
    return `<p class="step-desc">${escape(meta.hint)} 完成上一步后即可开始网页登录。</p>`;
  }
  if (connected || loginFlow?.phase === 'succeeded') {
    const idLine = loginFlow?.identitySummary ? ` · ${escape(loginFlow.identitySummary)}` : '';
    const modelLine = loginFlow?.modelCount ? `（检测到 ${loginFlow.modelCount} 个可用模型）` : '';
    return `<div class="auth-done"><span class="auth-done-mark">✓</span><div><strong>账号连接已通过${idLine}</strong><p class="step-desc">凭据已隔离保存在本机实例目录${modelLine}。</p></div></div>`;
  }
  const active = loginFlow && ['starting', 'awaiting-auth', 'submitting', 'verifying'].includes(loginFlow.phase);
  if (!active) {
    const failed = loginFlow?.phase === 'failed' ? `<p class="error" role="alert">${escape(loginFlow.error || loginFlow.message)}</p>` : '';
    return `<p class="step-desc">${escape(meta.hint)}</p>${failed}<div class="step-actions"><button type="button" class="primary" id="runtime-login" ${working ? 'disabled' : ''}>${working ? '正在准备链接…' : '开始官方登录'}</button><button type="button" id="runtime-account" ${working ? 'disabled' : ''}>已登录？检查连接</button></div>`;
  }
  const needsCode = loginFlow.mode === 'code-paste' || loginFlow.mode === 'hybrid';
  const pulseLabel = loginFlow.phase === 'verifying' ? '正在验证账号与可用模型…' : loginFlow.phase === 'submitting' ? '正在交换凭据…' : '等待你在浏览器完成官方授权…';
  return `<div class="auth-live" role="status"><span class="pulse-dot" aria-hidden="true"></span><span>${escape(pulseLabel)}</span></div>
    <p class="step-desc">${escape(loginFlow.message || meta.hint)}</p>
    ${loginFlow.authUrl ? `<div class="step-actions"><a class="btn-link primary" id="runtime-open-url" href="${escape(loginFlow.authUrl)}" target="_blank" rel="noopener noreferrer">打开官方登录页 ↗</a><button type="button" id="runtime-copy-url">${copiedUrl ? '✓ 已复制链接' : '复制登录链接'}</button><button type="button" id="runtime-cancel" ${working ? 'disabled' : ''}>取消</button></div>` : `<div class="step-actions"><button type="button" id="runtime-cancel" ${working ? 'disabled' : ''}>取消</button></div>`}
    ${needsCode ? `<form id="runtime-code-form" class="code-submit"><label class="field-inline-label" for="runtime-auth-code">${escape(loginFlow.mode === 'code-paste' ? '粘贴授权码或回调网址' : '页面给了授权码？粘贴到这里（自动完成时无需填写）')}</label><div class="code-row"><input id="runtime-auth-code" type="text" autocomplete="off" spellcheck="false" placeholder="${escape(runtimeKind === 'antigravity' ? '粘贴授权码或 https://antigravity.google/oauth-callback?…' : '粘贴官方页面显示的授权码')}" value="${escape(authCode)}" ${working || loginFlow.phase === 'verifying' ? 'disabled' : ''}><button type="submit" class="primary" id="runtime-code-submit" ${working || !authCode.trim() || loginFlow.phase === 'verifying' ? 'disabled' : ''}>提交</button></div></form>` : ''}
    ${loginFlow.error ? `<p class="error" role="alert">${escape(loginFlow.error)}</p>` : ''}
    <div class="auth-fallback"><button type="button" class="demo-link" id="runtime-account" ${working ? 'disabled' : ''}>已完成浏览器授权？立即检查连接</button></div>`;
}

function render() {
  clearTimeout(poll);
  document.querySelector('#steps').innerHTML = names.map((name, i) => `<li class="${i === step ? 'active' : i < step ? 'done' : ''}"><span class="num">${i < step ? '✓' : i + 1}</span>${name}</li>`).join('');
  if (step === 0) {
    const environment = state?.environment;
    panel.innerHTML = `<h1>先检查一下这台 Mac</h1><p class="lead">确认设备满足要求，再开始设置。</p><div class="rows">${environment ? environment.checks.filter(c => ['architecture', 'system', 'memory', 'disk'].includes(c.id) || !c.passed).map(c => `<div class="row"><div>${escape(c.label)}<small>${escape(c.passed ? ({ architecture: 'M 系列芯片，原生运行', system: `macOS ${environment.facts?.macosVersion || ''}`, memory: `${Math.round((environment.facts?.memoryBytes || 0) / 1024 ** 3)}GB · 至少 16GB`, disk: `剩余 ${((environment.facts?.freeBytes || 0) / 1000 ** 3).toFixed(1)}GB · 至少 40GB` }[c.id] || c.detail) : c.detail)}</small></div><span class="${c.passed ? 'ok' : 'error'}">${c.passed ? '✓ 符合要求' : '未通过'}</span></div>`).join('') : '<p>正在读取设备信息…</p>'}</div>${notice()}${actions(false, '开始设置', !environment?.eligible)}`;
  }
  if (step === 1) panel.innerHTML = `<h1>设置你的本机工作台</h1><p class="lead">账号和数据都属于你，无需注册中心账号。</p><form id="local"><label class="field">管理员密码<input id="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required placeholder="至少 12 个字符"></label><label class="field">再次输入密码<input id="confirm" type="password" autocomplete="new-password" required placeholder="确认管理员密码"></label><div class="notice">数据保存在当前用户的应用数据目录，默认工作区自动创建。升级应用会保留这些内容。</div>${notice()}${actions(true, '继续')}</form>`;
  if (step === 2 && !optional()) {
    panel.innerHTML = `<h1>连接你自己的模型账号</h1><p class="lead">先连接一个即可开始；进工作台后随时在「设置 → 运行时」新增其他账号。</p>${choices()}<label class="field">模型服务<select><option>DeepSeek</option></select></label><label class="field">API Key<input id="key" type="password" autocomplete="off" placeholder="填写你自己的 API Key"></label><p class="hint">检查会将 API Key 直接发送给 DeepSeek，不经过开发者服务器。凭据隔离保存在本机实例目录。</p><button id="connection" ${working ? 'disabled' : ''}>${working ? '正在检查…' : '检查连接'}</button>${models.length ? `<label class="field" style="margin-top:16px">默认模型<select id="model">${models.map(id => `<option value="${escape(id)}" ${id === selectedModel ? 'selected' : ''}>${escape(id)}</option>`).join('')}</select></label><p class="hint">✓ 连接已通过。模型调用仍需账户有可用额度。</p>` : ''}${notice()}${actions(true, '保存并继续', !models.length)}`;
  }
  if (step === 2 && optional()) {
    const configured = !!state?.configured, component = state?.onboarding?.component === 'installed', connected = state?.acceptance?.modelConnection === 'passed' || loginFlow?.phase === 'succeeded';
    const decision = networkResult?.decision;
    const netPassed = !!decision?.allowed;
    const label = RUNTIME_META[runtimeKind].title;
    const netDone = configured && !showNetworkRecheck;
    panel.innerHTML = `<h1>连接你自己的 ${escape(label)}</h1><p class="lead">全程在网页内完成，无需打开终端。进工作台后也可随时新增其他运行时。</p>${choices()}
      <div class="connect-stepper">
        <section class="connect-step${netDone || netPassed ? ' is-done' : ' is-active'}">
          <div class="step-head"><span class="step-badge">${netDone || netPassed ? '✓' : '1'}</span><h2>网络与地区检查</h2><span class="step-tag ${netDone || netPassed ? 'ok' : ''}">${netDone ? '已通过' : netPassed ? '本次通过' : '必检项'}</span></div>
          ${netDone ? `<div class="step-collapsed"><span>已保存本机设置，安装与登录前会自动实时复核出口网络。</span><button type="button" class="demo-link" id="toggle-net-recheck">重新检查 / 更换检测 Key</button></div>` : `
            <div class="net-key-row"><label class="field"><span class="field-caption">ipapi.is API Key</span><input id="network-key" ${working ? 'disabled' : ''} type="password" autocomplete="off" maxlength="4096" placeholder="填写你自己的检测 Key"></label><button type="button" id="network-check" ${working ? 'disabled' : ''}>${working ? '检查中…' : '检查网络'}</button></div>
            <p class="hint compact">检查会访问 ipconfig.io 与 ipapi.is 核对地区和机房类型；模型账号凭据不会发送给检测商。“非机房”不等于已证实住宅，也不保证账号安全。</p>
            ${networkSummaryHtml()}
          `}
        </section>
        <section class="connect-step${component ? ' is-done' : configured ? ' is-active' : ' is-locked'}">
          <div class="step-head"><span class="step-badge">${component ? '✓' : '2'}</span><h2>安装 ${escape(RUNTIME_META[runtimeKind].label)} 组件</h2><span class="step-tag ${component ? 'ok' : ''}">${component ? '已安装' : configured ? '待安装' : '等待上一步'}</span></div>
          ${component ? `<p class="step-desc">组件已安装到隔离目录并完成校验，不会改写宿主机全局 CLI 配置。</p>` : configured ? `<p class="step-desc">Heji 将下载并校验签名/哈希后安装到实例私有目录。</p><div class="step-actions"><button type="button" class="primary" id="runtime-install" ${working ? 'disabled' : ''}>${working ? '正在安装组件…' : `安装 ${RUNTIME_META[runtimeKind].label} 组件`}</button></div>` : `<p class="step-desc">通过网络检查并点击下方「保存并继续」后即可安装组件。</p>`}
        </section>
        <section class="connect-step${connected ? ' is-done' : component ? ' is-active' : ' is-locked'}">
          <div class="step-head"><span class="step-badge">${connected ? '✓' : '3'}</span><h2>网页官方登录</h2><span class="step-tag ${connected ? 'ok' : loginFlow && ['awaiting-auth', 'submitting', 'verifying'].includes(loginFlow.phase) ? 'accent' : ''}">${connected ? '已连接' : loginFlow && ['awaiting-auth', 'submitting', 'verifying'].includes(loginFlow.phase) ? '进行中' : component ? '待登录' : '等待安装'}</span></div>
          ${loginSectionHtml(configured, component, connected)}
        </section>
      </div>
      ${notice()}${actions(!configured, configured ? '进入首次任务' : '保存并继续', configured ? !connected : !netPassed)}`;
    if (configured && component && !connected && loginFlow && ['starting', 'awaiting-auth', 'submitting', 'verifying'].includes(loginFlow.phase)) {
      poll = setTimeout(pollLoginStatus, 1800);
    }
  }
  if (step === 3) {
    const acceptance = state?.acceptance; const passed = acceptance?.firstTask === 'passed';
    panel.innerHTML = `<h1>完成你的第一个任务</h1><p class="lead">验证 AI 能执行任务，并把结果保存在本机。</p><div class="notice">生成一份可勾选的本周计划，保存为网页，并展示预览。</div><p class="hint">运行会调用你配置的模型，可能产生少量费用。需要审批时，请进入任务会话处理。</p>${acceptance?.taskSession ? `<p role="status">任务状态：${escape(passed ? '执行和保存已通过' : state.taskStatus || '正在准备')}</p><p><a target="_blank" rel="noopener" href="${escape(state.taskUrl || '/#/rt')}">打开任务会话</a>${passed ? ' · <a target="_blank" rel="noopener" href="/api/local/first-preview">预览生成的网页</a>' : ''}</p>` : `<button id="task" ${working ? 'disabled' : ''}>${working ? '正在启动…' : '运行示例任务'}</button>`}${notice()}${actions(false, '完成设置', !passed)}`;
    if (acceptance?.taskSession && !passed) poll = setTimeout(refresh, 2500);
  }
  if (step === 4) panel.innerHTML = `<div class="success">✓</div><h1>工作台准备好了</h1><p class="lead">从一次对话开始，也可以记下待办、管理记忆和产物。</p><div class="rows"><div class="row"><span>数据保存</span><span>你的 Mac</span></div><div class="row"><span>访问范围</span><span>仅本机</span></div><div class="row"><span>模型账号</span><span>你自己的账号（实例强隔离）</span></div></div><label class="check"><input id="autostart" type="checkbox">登录 Mac 后自动启动</label><p class="hint">以后双击 pi-agent 即可继续使用。关闭网页不会停止后台任务。</p>${notice()}${actions(false, '进入工作台')}`;

  document.querySelector('#back')?.addEventListener('click', () => { message = ''; step--; render(); });
  document.querySelector('#local')?.addEventListener('submit', event => { event.preventDefault(); password = document.querySelector('#password').value; confirmation = document.querySelector('#confirm').value; if (password !== confirmation) { message = '两次密码不一致，请重新输入。'; render(); return; } message = ''; step = 2; render(); });
  if (step === 1) { document.querySelector('#password').value = password; document.querySelector('#confirm').value = confirmation; }
  if (step === 2 && !optional()) {
    document.querySelector('#key').value = apiKey;
    document.querySelector('#key').addEventListener('input', event => { apiKey = event.target.value; models = []; document.querySelector('#next').disabled = true; });
    document.querySelector('#model')?.addEventListener('change', event => { selectedModel = event.target.value; });
    document.querySelector('#connection').addEventListener('click', () => run(async () => { const result = await api('/api/local/model-check', { apiKey }); models = result.models; selectedModel = models.includes('deepseek-chat') ? 'deepseek-chat' : models[0]; }));
  }
  if (step === 2) {
    for (const button of document.querySelectorAll('[data-runtime]')) button.addEventListener('click', () => { runtimeKind = button.dataset.runtime; networkResult = undefined; loginFlow = null; authCode = ''; message = ''; showNetworkRecheck = false; render(); });
    if (optional()) {
      const keyInput = document.querySelector('#network-key');
      if (keyInput) {
        keyInput.value = networkApiKey;
        keyInput.addEventListener('input', event => { networkApiKey = event.target.value; networkResult = undefined; if (!state?.configured) document.querySelector('#next').disabled = true; });
      }
      document.querySelector('#toggle-net-recheck')?.addEventListener('click', () => { showNetworkRecheck = true; render(); });
      document.querySelector('#network-check')?.addEventListener('click', () => run(async () => { networkResult = await api('/api/local/network-check', { runtimeKind, ...(networkApiKey ? { apiKey: networkApiKey } : {}) }); networkApiKey = ''; if (state?.configured && networkResult?.decision?.allowed) showNetworkRecheck = false; }));
      document.querySelector('#runtime-install')?.addEventListener('click', () => run(async () => { await api('/api/local/runtime-install', {}); state = await api('/api/local/status'); }));
      document.querySelector('#runtime-login')?.addEventListener('click', () => run(async () => {
        copiedUrl = false; authCode = '';
        const result = await api('/api/local/runtime-login', {});
        loginFlow = result.flowId ? result : { flowId: '', mode: runtimeKind === 'antigravity' ? 'code-paste' : runtimeKind === 'claude-code' ? 'hybrid' : 'callback', phase: 'awaiting-auth', authUrl: result.authUrl || '', message: '请在新打开的官方页面完成授权。' };
        if (loginFlow.authUrl) window.open(loginFlow.authUrl, '_blank', 'noopener,noreferrer');
      }));
      document.querySelector('#runtime-copy-url')?.addEventListener('click', async () => {
        if (!loginFlow?.authUrl) return;
        try { await navigator.clipboard.writeText(loginFlow.authUrl); copiedUrl = true; render(); setTimeout(() => { copiedUrl = false; render(); }, 2000); } catch { message = '复制失败，请右键「打开官方登录页」复制链接'; render(); }
      });
      document.querySelector('#runtime-cancel')?.addEventListener('click', () => run(async () => {
        await api('/api/local/runtime-login/cancel', { flowId: loginFlow?.flowId });
        loginFlow = null; authCode = '';
      }));
      const codeInput = document.querySelector('#runtime-auth-code');
      if (codeInput) {
        codeInput.addEventListener('input', event => { authCode = event.target.value; const btn = document.querySelector('#runtime-code-submit'); if (btn) btn.disabled = working || !authCode.trim(); });
      }
      document.querySelector('#runtime-code-form')?.addEventListener('submit', event => {
        event.preventDefault();
        if (!authCode.trim() || !loginFlow?.flowId) return;
        void run(async () => {
          loginFlow = await api('/api/local/runtime-login/submit', { flowId: loginFlow.flowId, code: authCode.trim() });
          authCode = '';
          if (loginFlow?.phase === 'succeeded') state = await api('/api/local/status');
        });
      });
      document.querySelector('#runtime-account')?.addEventListener('click', () => run(async () => { await api('/api/local/runtime-account', {}); state = await api('/api/local/status'); if (state?.acceptance?.modelConnection === 'passed') loginFlow = { ...(loginFlow || {}), phase: 'succeeded' }; }));
    }
  }
  document.querySelector('#task')?.addEventListener('click', () => run(async () => { state = await api('/api/local/first-task', {}); }));
  document.querySelector('#next')?.addEventListener('click', event => {
    if (step === 1) return; event.preventDefault();
    if (step === 0) { step = 1; render(); }
    else if (step === 2) void run(async () => {
      if (optional()) {
        if (!state?.configured) {
          await api('/api/local/initialize', { password, passwordConfirmation: confirmation, runtimeKind });
          password = confirmation = networkApiKey = '';
          state = await api('/api/local/status');
        } else if (state.acceptance.modelConnection === 'passed' || loginFlow?.phase === 'succeeded') {
          step = 3;
        }
      } else {
        await api('/api/local/initialize', { password, passwordConfirmation: confirmation, model: { provider: 'deepseek', id: selectedModel, apiKey } });
        password = confirmation = apiKey = ''; models = [];
        state = await api('/api/local/status');
        step = 3;
      }
    });
    else if (step === 3) { step = 4; render(); }
    else if (step === 4) { const autoStart = document.querySelector('#autostart').checked; void run(async () => { if (autoStart) await api('/api/local/autostart', { enabled: true }); location.assign('/#/rt'); }); }
  });
}

async function pollLoginStatus() {
  if (step !== 2 || !optional() || !loginFlow?.flowId) return;
  try {
    const res = await api(`/api/local/runtime-login/status?flowId=${encodeURIComponent(loginFlow.flowId)}`);
    if (res.flow) loginFlow = res.flow;
    if (res.connected || loginFlow?.phase === 'succeeded') {
      state = await api('/api/local/status');
      render();
      return;
    }
    if (['failed', 'cancelled'].includes(loginFlow?.phase)) { render(); return; }
  } catch { /* 暂态失败下轮重试 */ }
  render();
}
async function run(operation) { if (working) return; working = true; message = ''; render(); try { await operation(); } catch (error) { message = error.message; } finally { working = false; render(); } }
async function refresh() { try { state = await api('/api/local/status'); message = ''; } catch (error) { message = error.message; } render(); }
function login() {
  document.querySelector('#steps').replaceChildren();
  panel.innerHTML = `<h1>打开你的本机工作台</h1><p class="lead">请输入安装时设置的管理员密码。</p><form id="login"><label class="field">管理员密码<input id="login-password" type="password" autocomplete="current-password" required></label><p class="error" id="login-error" role="alert"></p><button class="primary">登录</button></form>`;
  document.querySelector('#login').addEventListener('submit', async event => { event.preventDefault(); try { await api('/api/local/login', { password: document.querySelector('#login-password').value }); location.assign('/setup'); } catch (error) { document.querySelector('#login-error').textContent = error.message; } });
}
(async () => {
  const token = location.hash.slice(1); history.replaceState(null, '', location.pathname);
  if (token) { try { await api('/api/local/bootstrap', {}, `Bearer ${token}`); } catch (error) { message = error.message; login(); return; } }
  try {
    state = await api('/api/local/status');
    if (state.configured) {
      runtimeKind = state.runtimeKind || 'pi';
      if (state.acceptance.firstTask === 'passed') { location.replace('/#/rt'); return; }
      step = optional() && state.acceptance.modelConnection !== 'passed' ? 2 : 3;
    }
    render();
  } catch { login(); }
})();
