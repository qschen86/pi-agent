'use strict';
const names = ['检查环境', '本机设置', '连接账号', '首次任务', '完成'];
const panel = document.querySelector('#panel');
let step = 0, state, password = '', confirmation = '', apiKey = '', models = [], selectedModel = '', working = false, message = '', poll;
let runtimeKind = 'pi', networkApiKey = '', networkResult, officialAuthUrl = '';
const optional = () => runtimeKind !== 'pi';
const choices = () => `<div class="runtime-choices" role="group" aria-label="账号类型">${[['pi','API Key'],['codex','Codex'],['claude-code','Claude Code']].map(([id,label]) => `<button type="button" data-runtime="${id}" aria-pressed="${runtimeKind === id}" ${state?.configured || working ? 'disabled' : ''}>${label}</button>`).join('')}</div>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
async function api(path, body, authorization) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(authorization ? { authorization } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); if (!response.ok) throw Error(result.error || '操作未完成'); return result;
}
function actions(back, next, disabled = false) { return `<div class="actions">${back ? '<button id="back" type="button" ${working ? "disabled" : ""}>上一步</button>' : '<span>仅在你的 Mac 上设置</span>'}<button class="primary" id="next" ${disabled || working ? 'disabled' : ''}>${working ? '正在处理…' : next}</button></div>`; }
function notice() { return `<p class="error" role="alert">${escape(message)}</p>`; }
function render() {
  clearTimeout(poll);
  document.querySelector('#steps').innerHTML = names.map((name, i) => `<li class="${i === step ? 'active' : i < step ? 'done' : ''}"><span class="num">${i < step ? '✓' : i + 1}</span>${name}</li>`).join('');
  if (step === 0) {
    const environment = state?.environment;
    panel.innerHTML = `<h1>先检查一下这台 Mac</h1><p class="lead">确认设备满足要求，再开始设置。</p><div class="rows">${environment ? environment.checks.filter(c => ['architecture', 'system', 'memory', 'disk'].includes(c.id) || !c.passed).map(c => `<div class="row"><div>${escape(c.label)}<small>${escape(c.passed ? ({ architecture: 'M 系列芯片，原生运行', system: `macOS ${environment.facts?.macosVersion || ''}`, memory: `${Math.round((environment.facts?.memoryBytes || 0) / 1024 ** 3)}GB · 至少 16GB`, disk: `剩余 ${((environment.facts?.freeBytes || 0) / 1000 ** 3).toFixed(1)}GB · 至少 40GB` }[c.id] || c.detail) : c.detail)}</small></div><span class="${c.passed ? 'ok' : 'error'}">${c.passed ? '✓ 符合要求' : '未通过'}</span></div>`).join('') : '<p>正在读取设备信息…</p>'}</div>${notice()}${actions(false, '开始设置', !environment?.eligible)}`;
  }
  if (step === 1) panel.innerHTML = `<h1>设置你的本机工作台</h1><p class="lead">账号和数据都属于你，无需注册中心账号。</p><form id="local"><label class="field">管理员密码<input id="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required placeholder="至少 12 个字符"></label><label class="field">再次输入密码<input id="confirm" type="password" autocomplete="new-password" required placeholder="确认管理员密码"></label><div class="notice">数据保存在当前用户的应用数据目录，默认工作区自动创建。升级应用会保留这些内容。</div>${notice()}${actions(true, '继续')}</form>`;
  if (step === 2 && !optional()) panel.innerHTML = `<h1>连接你自己的模型账号</h1><p class="lead">先连接一个模型，即可开始使用。</p>${choices()}<label class="field">模型服务<select><option>DeepSeek</option></select></label><label class="field">API Key<input id="key" type="password" autocomplete="off" placeholder="填写你自己的 API Key"></label><p class="hint">检查会将 API Key 直接发送给 DeepSeek，不经过开发者服务器。对话及推荐操作费用由模型服务商收取。</p><button id="connection" ${working ? 'disabled' : ''}>${working ? '正在检查…' : '检查连接'}</button>${models.length ? `<label class="field">默认模型<select id="model">${models.map(id => `<option value="${escape(id)}" ${id === selectedModel ? 'selected' : ''}>${escape(id)}</option>`).join('')}</select></label><p class="hint">连接已通过。保存时会再核对一次。</p>` : ''}${notice()}${actions(true, '保存并继续', !models.length)}`;
  if (step === 2 && optional()) {
    const configured = state?.configured, component = state?.onboarding?.component === 'installed', connected = state?.acceptance?.modelConnection === 'passed';
    const report = networkResult?.report, decision = networkResult?.decision;
    const label = runtimeKind === 'codex' ? 'Codex' : 'Claude Code';
    const labels = {region:'支持地区',connectivity:'官方服务连通性',networkType:'IP 类型'};
    const failures = {'classification-unavailable':'当前响应缺少机房分类。请填写自己的 ipapi.is Key 后重新检查。','rate-limited':'检测额度已用完，请稍后重试。','exit-changed':'检查期间出口发生变化，请重新检查。','ip-mismatch':'两次查询的 IP 不一致，请检查网络。','lookup-unavailable':'无法完成检测，请检查网络后重试。'};
    panel.innerHTML = `<h1>连接你自己的 ${label} 账号</h1><p class="lead">先检查网络，再安装组件和登录账号。</p>${choices()}<label class="field">ipapi.is API Key<input id="network-key" ${working ? "disabled" : ""} type="password" autocomplete="off" maxlength="4096" placeholder="填写你自己的检测 Key"></label><p class="hint">检查会访问 ipconfig.io，并将出口 IP 发送至 ipapi.is，用于核对地区与机房类型。检测 Key 仅保存在本机，模型账号凭据不会发送给检测商。匿名查询可能不含类型字段，无法确认时不放行。</p><button id="network-check" ${working ? 'disabled' : ''}>${working ? '正在处理…' : '检查网络'}</button>${report ? `<div class="rows" role="status"><div class="row"><span>出口国家</span><span>${escape(report.exit?.countryCode || '未确认')}</span></div>${Object.entries(labels).map(([id,label]) => `<div class="row"><span>${label}</span><span class="${report.checks[id]?.status === 'passed' ? 'ok' : 'error'}">${report.checks[id]?.status === 'passed' ? id === 'networkType' ? '非机房' : '通过' : report.checks[id]?.status === 'failed' ? '未通过' : '无法确认'}</span></div>`).join('')}</div><p class="hint">${decision?.allowed ? '本次检查通过。安装、登录和首次任务前仍会重新检查。' : escape(failures[networkResult.failure] || '网络检查未通过，安装和登录已停止。')}</p>` : ''}<p class="hint">“非机房”不等于已证实住宅，也不保证账号安全。出口地区通过不能替代服务商的其他使用条件。</p>${configured ? `<div class="notice">${component ? '✓ 运行时组件已安装' : '本机设置已保存，接下来安装所选组件。'}</div>${!component ? '<button id="runtime-install">安装运行时组件</button>' : `<button id="runtime-login">打开官方登录</button><button id="runtime-account">我已完成登录，检查连接</button>${officialAuthUrl ? `<p><a href="${escape(officialAuthUrl)}" target="_blank" rel="noopener noreferrer">继续官方登录</a></p>` : ""}<p class="hint">${connected ? '✓ 账号连接已通过' : '请在官方页面登录自己的账号，再返回这里检查连接。'}</p>`}` : ''}${notice()}${actions(!configured, configured ? '进入首次任务' : '保存并继续', configured ? !connected : !decision?.allowed)}`;
  }
  if (step === 3) {
    const acceptance = state?.acceptance; const passed = acceptance?.firstTask === 'passed';
    panel.innerHTML = `<h1>完成你的第一个任务</h1><p class="lead">验证 AI 能执行任务，并把结果保存在本机。</p><div class="notice">生成一份可勾选的本周计划，保存为网页，并展示预览。</div><p class="hint">运行会调用你配置的模型，可能产生少量费用。需要审批时，请进入任务会话处理。</p>${acceptance?.taskSession ? `<p role="status">任务状态：${escape(passed ? '执行和保存已通过' : state.taskStatus || '正在准备')}</p><p><a target="_blank" rel="noopener" href="${escape(state.taskUrl || '/#/rt')}">打开任务会话</a>${passed ? ' · <a target="_blank" rel="noopener" href="/api/local/first-preview">预览生成的网页</a>' : ''}</p>` : `<button id="task" ${working ? 'disabled' : ''}>${working ? '正在启动…' : '运行示例任务'}</button>`}${notice()}${actions(false, '完成设置', !passed)}`;
    if (acceptance?.taskSession && !passed) poll = setTimeout(refresh, 2500);
  }
  if (step === 4) panel.innerHTML = `<div class="success">✓</div><h1>工作台准备好了</h1><p class="lead">从一次对话开始，也可以记下待办、管理记忆和产物。</p><div class="rows"><div class="row"><span>数据保存</span><span>你的 Mac</span></div><div class="row"><span>访问范围</span><span>仅本机</span></div><div class="row"><span>模型账号</span><span>你自己的账号</span></div></div><label class="check"><input id="autostart" type="checkbox">登录 Mac 后自动启动</label><p class="hint">以后双击 pi-agent 即可继续使用。关闭网页不会停止后台任务。</p>${notice()}${actions(false, '进入工作台')}`;
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
    for (const button of document.querySelectorAll('[data-runtime]')) button.addEventListener('click', () => { runtimeKind = button.dataset.runtime; networkResult = undefined; message = ''; render(); });
    if (optional()) {
      document.querySelector('#network-key').value = networkApiKey;
      document.querySelector('#network-key').addEventListener('input', event => { networkApiKey = event.target.value; networkResult = undefined; if (!state?.configured) document.querySelector('#next').disabled = true; });
      document.querySelector('#network-check').addEventListener('click', () => run(async () => { networkResult = await api('/api/local/network-check', {runtimeKind, ...(networkApiKey ? {apiKey:networkApiKey} : {})}); networkApiKey = ''; }));
      document.querySelector('#runtime-install')?.addEventListener('click', () => run(async () => { await api('/api/local/runtime-install', {}); state = await api('/api/local/status'); }));
      document.querySelector('#runtime-login')?.addEventListener('click', () => run(async () => { const result = await api('/api/local/runtime-login', {}); if (result.authUrl) { officialAuthUrl = result.authUrl; window.open(result.authUrl, '_blank', 'noopener,noreferrer'); message='已发起官方登录，完成后请检查连接。'; } else message='已发起官方登录，请完成后检查连接。'; }));
      document.querySelector('#runtime-account')?.addEventListener('click', () => run(async () => { await api('/api/local/runtime-account', {}); state = await api('/api/local/status'); }));
    }
  }
  document.querySelector('#task')?.addEventListener('click', () => run(async () => { state = await api('/api/local/first-task', {}); }));
  document.querySelector('#next')?.addEventListener('click', event => {
    if (step === 1) return; event.preventDefault();
    if (step === 0) { step = 1; render(); }
    else if (step === 2) void run(async () => {
      if (optional()) { if (!state?.configured) { await api('/api/local/initialize', {password,passwordConfirmation:confirmation,runtimeKind}); password=confirmation=networkApiKey=''; state=await api('/api/local/status'); } else if (state.acceptance.modelConnection === 'passed') step=3; }
      else { await api('/api/local/initialize', { password, passwordConfirmation: confirmation, model: { provider: 'deepseek', id: selectedModel, apiKey } }); password = confirmation = apiKey = ''; models = []; state = await api('/api/local/status'); step = 3; }
    });
    else if (step === 3) { step = 4; render(); }
    else if (step === 4) { const autoStart = document.querySelector('#autostart').checked; void run(async () => { if (autoStart) await api('/api/local/autostart', { enabled: true }); location.assign('/#/rt'); }); }
  });
  // 手机上操作栏吸底，提示文字会被它盖住：有提示时把它滚到视野内，否则用户只看到“没反应”。
  if (message) panel.querySelector('.error')?.scrollIntoView({ block: 'center' });
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
  try { state = await api('/api/local/status'); if (state.configured) { runtimeKind = state.runtimeKind || 'pi'; if (state.acceptance.firstTask === 'passed') { location.replace('/#/rt'); return; } step = optional() && state.acceptance.modelConnection !== 'passed' ? 2 : 3; } render(); }
  catch { login(); }
})();
