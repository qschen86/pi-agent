"use strict";
// Private transient view state. No contacts or statistics are saved in browser storage.
(() => {
    const S = { active: false, generation: 0, tab: 'overview', deviceId: '', devices: null, stats: null, contacts: null, error: '', loading: false, busy: false, range: '90', from: '', through: '', q: '', native: null, capable: false, preview: null, route: '', showRanks: false };
    let poll = 0, searchTimer = 0;
    const label = { contacts: '通讯录', calls: '通话记录', sms: '短信' };
    const paths = { contacts: 'M5 3h15v18H5zM3 7h4M3 12h4M3 17h4M10 16c0-3 6-3 6 0M13 7v3', phone: 'M5 3h4l2 5-3 2a14 14 0 0 0 6 6l2-3 5 2v4c0 2-2 3-4 2C9 19 5 15 3 7c-1-2 0-4 2-4z', clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', sms: 'M3 5h18v14H3zM3 5l9 7 9-7', spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z', sync: 'M20 7a8 8 0 0 0-14-2L3 8m0-5v5h5M4 17a8 8 0 0 0 14 2l3-3m0 5v-5h-5', shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3zM8 12l3 3 5-6', chevron: 'm9 5 7 7-7 7', device: 'M6 2h12v20H6zM10 18h4' };
    const icon = name => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'com-icon'); s.setAttribute('aria-hidden', 'true'); const p = document.createElementNS(s.namespaceURI, 'path'); p.setAttribute('d', paths[name] || paths.contacts); s.append(p); return s; };
    const btn = (text, click, primary = false, props = {}) => h('button', { type: 'button', class: `btn ${primary ? 'primary' : ''}`, onclick: click, ...props }, text);
    const redraw = () => { if (S.active && ui.view === 'communications')
        renderMain(); };
    const mask = n => n === '@private' ? '隐藏号码' : String(n).length > 4 ? '•••• ' + String(n).slice(-4) : '隐藏号码';
    const count = n => Number(n || 0).toLocaleString('zh-CN');
    const stamp = t => t ? new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '尚未成功同步';
    const duration = n => `${Math.floor(Number(n || 0) / 3600)} 时 ${Math.floor(Number(n || 0) % 3600 / 60)} 分`;
    const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    function dates() { if (S.range === 'custom')
        return { from: S.from, through: S.through }; const through = today(); return { through, ...(S.range === 'all' ? {} : { from: new Date(Date.parse(through) - (Number(S.range) - 1) * 86400000).toISOString().slice(0, 10) }) }; }
    function routeKey() { const m = location.hash.match(/^#\/communications\/contact\/(.+)$/); try {
        return m ? decodeURIComponent(m[1]) : null;
    }
    catch {
        return null;
    } }
    function query(extra = {}) { return new URLSearchParams({ deviceId: S.deviceId, ...dates(), ...extra }).toString(); }
    function clearData() { S.stats = null; S.contacts = null; S.preview = null; }
    function deactivate() { S.active = false; S.generation++; clearTimeout(poll); clearTimeout(searchTimer); clearData(); S.devices = null; S.native = null; S.capable = false; S.error = ''; S.busy = false; S.loading = false; }
    async function nativeStatus() { if (!S.capable || !window.piAndroidShell)
        return null; return window.piAndroidShell.call('communications.status'); }
    async function load({ more = false } = {}) {
        const generation = ++S.generation;
        S.loading = true;
        S.error = '';
        redraw();
        try {
            const list = await api('/api/communications/devices');
            if (!S.active || generation !== S.generation)
                return;
            S.devices = list.devices || [];
            if (S.capable && S.native?.deviceId && !S.devices.some(d => d.deviceId === S.native.deviceId))
                S.devices.push({ deviceId: S.native.deviceId, enabled: S.native.enabled, localOnly: true, lastSuccessByKind: {} });
            if (!S.deviceId || (!S.devices.some(d => d.deviceId === S.deviceId) && S.deviceId !== 'all'))
                S.deviceId = S.native?.deviceId || S.devices[0]?.deviceId || '';
            if (!S.devices.some(d => d.deviceId === S.deviceId) && S.deviceId !== 'all')
                S.deviceId = S.devices[0]?.deviceId || '';
            if (!S.deviceId) {
                clearData();
                return;
            }
            const key = routeKey(), params = query(key ? { numberKey: key } : {});
            const [stats, contacts, native] = await Promise.all([api('/api/communications/stats?' + params), api('/api/communications/contacts?' + query({ q: S.q, limit: '50', ...(more && S.contacts?.nextCursor ? { cursor: S.contacts.nextCursor } : {}) })), nativeStatus()]);
            if (!S.active || generation !== S.generation)
                return;
            S.stats = stats;
            S.contacts = more ? { ...contacts, items: [...(S.contacts?.items || []), ...contacts.items] } : contacts;
            S.native = native;
            clearTimeout(poll);
            if (S.capable && S.native?.pending)
                poll = setTimeout(() => void load(), 2000);
        }
        catch (e) {
            if (!S.active || generation !== S.generation)
                return;
            if (e.status === 401 || e.status === 403)
                clearData();
            if (e.status === 409 && more) {
                S.contacts = null;
                queueMicrotask(() => void load());
                return;
            }
            S.error = e.message || '通讯数据读取失败';
        }
        finally {
            if (S.active && generation === S.generation) {
                S.loading = false;
                redraw();
            }
        }
    }
    async function activate() { S.active = true; try {
        if (window.piAndroidShell) {
            const current = await window.piAndroidShell.call('shell.status');
            if (!S.active)
                return;
            S.capable = current.capabilities?.includes('communications.v1') === true;
            if (S.capable)
                S.native = await nativeStatus();
        }
    }
    catch {
        S.capable = false;
    } if (S.active)
        void load(); }
    async function action(fn) { if (S.busy)
        return; S.busy = true; S.error = ''; redraw(); try {
        await fn();
        if (S.active)
            await load();
    }
    catch (e) {
        if (S.active)
            S.error = e.message || '操作未完成';
    }
    finally {
        if (S.active) {
            S.busy = false;
            redraw();
        }
    } }
    function chooseDevice(v) { S.deviceId = v; clearData(); void load(); }
    function changeRange(v) { S.range = v; if (v === 'custom') {
        const d = today();
        S.from = new Date(Date.parse(d) - 29 * 86400000).toISOString().slice(0, 10);
        S.through = d;
    } clearData(); void load(); }
    function filters() {
        const devices = S.devices || [];
        const select = h('select', { 'aria-label': '设备', onchange: e => chooseDevice(e.target.value) }, ...devices.map(d => h('option', { value: d.deviceId, selected: S.deviceId === d.deviceId }, S.native?.deviceId === d.deviceId ? '我的 Android 手机' : `Android · ${d.deviceId}`)), ...(devices.length > 1 ? [h('option', { value: 'all', selected: S.deviceId === 'all' }, '全部设备（计数相加）')] : []));
        if (!devices.length)
            select.append(h('option', {}, '尚未连接设备'));
        const range = h('select', { 'aria-label': '时间范围', onchange: e => changeRange(e.target.value) }, ...[['90', '最近 90 天'], ['30', '最近 30 天'], ['all', '全部已同步记录'], ['custom', '自选日期']].map(([v, t]) => h('option', { value: v, selected: S.range === v }, t)));
        const selected = devices.find(d => d.deviceId === S.deviceId), times = Object.values(selected?.lastSuccessByKind || {}).sort();
        return h('div', { class: 'com-filters' }, h('div', { class: 'com-filter-controls' }, select, range, ...(S.range === 'custom' ? ['from', 'through'].map(k => h('label', { class: 'com-date-label' }, k === 'from' ? '从' : '至', h('input', { type: 'date', value: S[k], 'aria-label': k === 'from' ? '开始日期' : '结束日期', onchange: e => { S[k] = e.target.value; clearData(); void load(); } }))) : [])), h('div', { class: 'com-meta' }, S.loading ? '正在读取…' : times.length ? `最近成功 ${stamp(times.at(-1))} · 北京时间` : '尚未同步'));
    }
    function metric(title, value, foot, name) { return h('div', { class: 'com-metric' }, h('div', { class: 'com-label' }, title, icon(name)), h('div', { class: 'com-value' }, value), h('div', { class: 'com-foot' }, foot)); }
    function chart() {
        const days = S.stats?.days || [], max = Math.max(1, ...days.map(d => Math.max(d.incoming + d.outgoing + d.missed + d.rejected + d.other, d.received + d.sent)));
        const panel = h('section', { class: 'com-panel' }, h('div', { class: 'com-panel-title' }, h('h2', {}, '联系趋势'), h('div', { class: 'com-legend' }, h('span', {}, h('i', {}), '通话'), h('span', {}, h('i', { class: 'com-secondary' }), '短信'))));
        if (!days.length) {
            panel.append(h('div', { class: 'com-empty' }, '所选范围内暂无通话或短信统计'));
            return panel;
        }
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'com-chart');
        svg.setAttribute('viewBox', '0 0 600 200');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('aria-label', '按北京时间日期的通话与短信次数');
        svg.setAttribute('role', 'img');
        const add = (tag, attrs) => { const e = document.createElementNS(svg.namespaceURI, tag); for (const [k, v] of Object.entries(attrs))
            e.setAttribute(k, String(v)); svg.append(e); return e; };
        for (let i = 0; i < 4; i++) {
            const y = 20 + i * 50;
            add('path', { d: `M28 ${y}H596`, stroke: 'var(--border)', 'stroke-dasharray': '3 5', fill: 'none' });
            const text = add('text', { x: 0, y: y + 4, fill: 'var(--muted)', 'font-size': 10 });
            text.textContent = String(Math.round(max * (1 - i / 3)));
        }
        ['calls', 'sms'].forEach((kind, i) => { const points = days.map((d, n) => `${28 + (days.length === 1 ? .5 : n / (days.length - 1)) * 568},${170 - (kind === 'calls' ? d.incoming + d.outgoing + d.missed + d.rejected + d.other : d.received + d.sent) / max * 150}`).join(' '); add('polyline', { points, fill: 'none', stroke: i ? '#aaa3cc' : 'var(--accent)', 'stroke-width': 2, 'stroke-dasharray': i ? '5 4' : 'none', 'vector-effect': 'non-scaling-stroke' }); if (days.length === 1) {
            const [x, y] = points.split(',');
            add('circle', { cx: x, cy: y, r: 3, fill: i ? '#aaa3cc' : 'var(--accent)' });
        } });
        panel.append(svg, h('div', { class: 'com-chart-label' }, h('span', {}, days[0].date), h('span', {}, days.at(-1).date)), h('div', { class: 'com-chart-label' }, '按日汇总 · 次数', '北京时间'));
        return panel;
    }
    function openPerson(r) { if (r.deviceId && S.deviceId !== r.deviceId)
        S.deviceId = r.deviceId; location.hash = '#/communications/contact/' + encodeURIComponent(r.key); S.preview = null; void load(); }
    function overview() {
        const t = S.stats?.totals;
        if (!t || !Object.keys(S.stats?.coverage || {}).length && S.devices?.find(d => d.deviceId === S.deviceId)?.localOnly)
            return h('div', { class: 'com-empty' }, S.loading ? '正在读取统计…' : '尚未同步数据，请在 Android App 的「同步与权限」中启用同步。');
        const rows = S.stats.rankings || [];
        const ready = k => Object.values(S.stats.coverage || {}).some(d => d[k]?.lastSuccess);
        const quality = k => Object.values(S.stats.coverage || {}).some(d => d[k] && d[k].state && d[k].state !== 'success') ? ' · 历史统计，见下方状态' : '';
        return h('div', {}, h('div', { class: 'com-grid' }, metric('联系人', ready('contacts') ? h('span', {}, count(t.contacts), h('small', {}, '人')) : '—', ready('contacts') ? `共 ${count(t.numbers)} 个电话号码${quality('contacts')}` : '尚未成功同步', 'contacts'), metric('通话次数', ready('calls') ? h('span', {}, count(t.incoming + t.outgoing + t.missed + t.rejected + t.other), h('small', {}, '次')) : '—', ready('calls') ? `呼入 ${count(t.incoming)} · 呼出 ${count(t.outgoing)} · 未接 ${count(t.missed)}${t.rejected || t.other ? ` · 拒接 ${count(t.rejected)} · 其他 ${count(t.other)}` : ''}${quality('calls')}` : '尚未成功同步', 'phone'), metric('通话时长', ready('calls') ? duration(t.incomingSeconds + t.outgoingSeconds) : '—', ready('calls') ? '仅统计已接通的通话' + quality('calls') : '尚未成功同步', 'clock'), metric('短信收发', ready('sms') ? h('span', {}, count(t.received + t.sent), h('small', {}, '条')) : '—', ready('sms') ? `收到 ${count(t.received)} · 发出 ${count(t.sent)}${quality('sms')}` : '尚未成功同步', 'sms')), h('div', { class: 'com-dashboard' }, chart(), h('section', { class: 'com-panel' }, h('div', { class: 'com-panel-title' }, h('h2', {}, '常联系的人'), btn(S.showRanks ? '收起' : '全部', () => { S.showRanks = !S.showRanks; redraw(); })), rows.length ? rows.slice(0, S.showRanks ? 20 : 4).map(r => h('button', { class: 'com-rank', onclick: () => openPerson(r) }, h('span', { class: 'com-avatar' }, r.names[0]?.slice(0, 1) || '#'), h('span', { class: 'com-person-name' }, r.names.join(' / ') || mask(r.key), h('small', {}, duration(r.seconds))), h('span', { class: 'com-bar' }, h('i', { style: `width:${Math.max(3, r.calls / Math.max(1, rows[0].calls) * 100)}%` })), h('span', { class: 'com-rank-count' }, `${count(r.calls)} 次`))) : h('p', { class: 'muted' }, '所选范围没有通话统计'))), coverage());
    }
    function coverage() { const cov = S.stats?.coverage || {}; return h('div', {}, S.stats?.aggregation === 'device-sum' ? h('div', { class: 'com-alert' }, '当前为各设备计数之和，同一条记录可能在多台设备出现，未做跨设备去重。') : null, h('div', { class: 'com-note' }, icon('shield'), h('span', {}, '统计来自手机已同步记录，不包含短信正文；最近扫描窗口以外的历史保留原采集时间。', ...Object.entries(cov).map(([id, kinds]) => h('div', {}, ...['contacts', 'calls', 'sms'].map(k => h('div', {}, `${id} · ${label[k]}：${kinds[k] ? `状态 ${({ success: '已同步', denied: '未授权', restricted: '系统受限', failed: '读取失败', unknown: '未知' })[kinds[k].state] || '未知'}；${kinds[k].retainedFrom || kinds[k].fromDate || '系统保留记录'} 至 ${kinds[k].throughDate}，同步于 ${stamp(kinds[k].lastSuccess)}` : '尚未成功同步'}`))))))); }
    function contacts() { return h('div', {}, h('input', { class: 'com-search', type: 'search', value: S.q, placeholder: '搜索姓名或电话号码', 'aria-label': '搜索联系人', oninput: e => { S.q = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => void load(), 350); } }), h('section', { class: 'com-panel' }, h('div', { class: 'com-meta' }, `联系人 · ${S.contacts?.total ?? 0} 人 · 按姓名排序`), ...(S.contacts?.items || []).map(c => h('div', { class: 'com-contact' }, h('div', { class: 'com-contact-person' }, h('span', { class: 'com-avatar' }, c.name?.slice(0, 1) || '#'), h('div', {}, h('div', { class: 'com-person-name' }, c.name || '未命名联系人'), ...c.phones.map(p => h('div', { class: 'com-contact-phones' }, `${mask(p.key)} · ${p.label || '电话号码'}`)))), h('div', { class: 'com-contact-actions' }, ...c.phones.map(p => btn(c.phones.length > 1 ? mask(p.key) : '查看统计', () => openPerson({ key: p.key, deviceId: c.deviceId })))))), !S.contacts?.items?.length ? h('div', { class: 'com-empty' }, S.loading ? '正在读取联系人…' : S.q ? '没有匹配的联系人' : '暂无已同步联系人') : null), S.contacts?.nextCursor ? btn('加载更多', () => void load({ more: true }), false, { disabled: S.loading }) : null, coverage()); }
    function sync() {
        const current = S.devices?.find(d => d.deviceId === S.deviceId), n = S.native, own = S.capable && n?.deviceId === S.deviceId;
        const controls = own ? h('button', { class: 'com-switch', role: 'switch', 'aria-label': '启用同步', 'aria-checked': String(!!n.enabled), disabled: S.busy || n.pending, onclick: () => void action(async () => { if (n.enabled)
                await window.piAndroidShell.call('communications.stop');
            else if (confirm(`将通讯录姓名、电话号码及通话 / 短信统计同步到当前已配对的 pi-agent 服务端（${location.origin}）。不读取短信正文。是否启用？`))
                await window.piAndroidShell.call('communications.enable', { window: S.range === 'all' ? 'all' : Number(S.range === 'custom' ? '90' : S.range) }); }) }) : null;
        const device = h('section', { class: 'com-panel' }, h('div', { class: 'com-panel-title' }, h('div', { class: 'com-device' }, h('span', { class: 'com-avatar' }, icon('device')), h('div', {}, h('h2', {}, own ? '我的 Android 手机' : current ? `Android · ${current.deviceId}` : '等待连接 Android 手机'), h('div', { class: 'com-meta' }, own ? '已配对 · 原生能力已连接' : '电脑端可查看已同步数据')))), h('div', { class: 'com-setting' }, h('div', {}, '同步到 pi-agent', h('p', {}, '回到 App 时检查变化；后台不承诺实时同步。')), controls || h('span', { class: 'com-meta' }, current?.enabled ? '已启用' : '未启用')), h('div', { class: 'com-setting' }, h('div', {}, '统计范围', h('p', {}, '这是手机实际采集范围，与页面查看筛选独立。')), h('span', { class: 'com-meta' }, own ? h('div', {}, h('select', { 'aria-label': '手机采集范围', value: n.window || '90', disabled: S.busy || n.pending || !n.enabled, onchange: e => { const window = e.target.value; void action(() => window.piAndroidShell.call('communications.enable', { window: window === 'all' ? 'all' : Number(window) })); } }, ...['30', '90', 'all'].map(v => h('option', { value: v, selected: String(n.window || '90') === v }, v === 'all' ? '全部' : `${v} 天`)))) : h('span', { class: 'com-meta' }, '在手机设置'))), h('div', { class: 'com-setting' }, h('div', {}, '同步状态', h('p', {}, n?.pending ? '正在读取并上传…' : '各类成功时间见右侧权限状态')), own ? btn(n.pending ? '同步中…' : '立即同步', () => void action(() => window.piAndroidShell.call('communications.sync')), false, { disabled: S.busy || n.pending || !n.enabled }) : null), h('div', { class: 'com-note' }, icon('shield'), `目的地：${location.origin}。同步姓名、号码和统计，不上传短信正文。`), !S.capable ? h('div', { class: 'com-alert' }, window.piAndroidShell ? '当前 APK 不支持通讯录，请升级客户端后授权与同步。' : '请在 Android App 内授权和同步；电脑端可查看与删除服务端数据。') : null);
        const permissions = h('section', { class: 'com-panel' }, h('div', { class: 'com-panel-title' }, h('h2', {}, '数据权限'), h('span', { class: 'com-meta' }, '分别授权')), ...Object.keys(label).map(k => { const p = own ? n.permissionsByKind?.[k] : null, error = own ? n.errorsByKind?.[k] : current?.statuses?.[k]?.state === 'success' ? null : current?.statuses?.[k]?.state; return h('div', { class: 'com-setting' }, h('div', {}, label[k], h('p', {}, `上次成功：${stamp(current?.lastSuccessByKind?.[k])}`), error ? h('p', { class: 'com-status warn' }, error === 'denied' ? '未获得读取权限，可能需要系统安装器许可' : error === 'restricted' ? '系统限制了读取权限' : errorText(error)) : null), own ? btn(p === 'allowed' ? '已允许' : '授权', () => void action(() => window.piAndroidShell.call('communications.permission', { kind: k })), false, { disabled: S.busy || n.pending, class: `btn ${p === 'allowed' ? 'com-status' : ' '}` }) : h('span', { class: 'com-meta' }, '在手机管理')); }), h('div', { class: 'com-alert' }, '权限受限或读取失败时保留已有统计，不影响其他类别同步。'));
        return h('div', { class: 'com-sync-layout' }, device, permissions, current && !current.localOnly ? h('section', { class: 'com-panel com-privacy' }, h('div', { class: 'com-setting' }, h('div', {}, '服务端数据', h('p', {}, '停止同步保留历史；删除后需在手机重新启用。')), btn('删除此设备通讯数据', () => void action(async () => { if (confirm('删除此设备在服务端的通讯录和统计，并停止同步？')) {
            await api('/api/communications/devices/' + encodeURIComponent(current.deviceId) + '/data', { method: 'DELETE' });
            clearData();
        } }), false, { class: 'btn com-danger', disabled: S.busy }))) : null);
    }
    function errorText(code) { return ({ COMMUNICATIONS_NETWORK: '网络暂不可用，将在回前台时重试', COMMUNICATIONS_CHANGED: '读取期间数据变化，请重试', COMMUNICATIONS_EPOCH: '同步已停止或数据已删除，请重新启用', COMMUNICATIONS_TOO_LARGE: '数据超出容量，请缩小统计范围', COMMUNICATIONS_READ_FAILED: '系统读取失败，请稍后重试', COMMUNICATIONS_HTTP_401: '设备登录失效，请重新配对', COMMUNICATIONS_HTTP_429: '请求过于频繁，请稍后重试' })[code] || '同步暂未完成，请重试'; }
    function detail() { const key = routeKey(); const rank = S.stats?.rankings?.find(r => r.key === key); return h('div', {}, btn('返回联系人', () => { location.hash = '#/communications'; S.tab = 'contacts'; void load(); }), h('div', { class: 'com-detail-head' }, h('span', { class: 'com-avatar' }, rank?.names[0]?.slice(0, 1) || '#'), h('div', {}, h('h2', {}, rank?.names.join(' / ') || mask(key)), h('div', { class: 'com-contact-phones' }, mask(key)))), overview()); }
    function render() { if (S.route !== location.hash) {
        S.route = location.hash;
        if (S.active && S.devices) {
            clearData();
            queueMicrotask(() => void load());
        }
    } if (!S.active) {
        S.active = true;
        queueMicrotask(() => void activate());
    } const key = routeKey(); const root = h('section', { class: 'communications', 'aria-label': '通讯录' }, h('div', { class: 'com-heading' }, h('h1', {}, S.preview ? 'AI 分析' : '通讯录'), h('div', { class: 'com-actions page-navigation-actions' }, btn(S.capable?'同步':'刷新',()=>{if(S.capable){S.tab='sync';redraw();}else void load();},false,{class:'btn com-desktop-sync',disabled:S.loading}), !S.preview ? btn(h('span', {}, icon('spark'), ' AI 分析'), () => { if (S.stats) {
        S.preview = window.communicationsBuildAnalysis(structuredClone(S.stats), { deviceId: S.deviceId, ...dates() });
        redraw();
    } }, true, { disabled: !S.stats || !Object.values(S.stats.coverage||{}).some(kinds=>Object.values(kinds).some(kind=>kind.lastSuccess)) || S.loading }) : null)), h('div', { class: 'com-tabs inpage-tabs', role: 'tablist' }, ...[['overview', '总览'], ['contacts', `联系人${S.contacts?.total === undefined ? '' : ` ${S.contacts.total}`}`], ['sync', '同步与权限']].map(([id, text]) => btn(text, () => { S.tab = id; S.preview = null; if (key) {
        location.hash = '#/communications';
        void load();
    }
    else
        redraw(); }, false, { class: `${S.tab === id ? 'active' : ''}`, role: 'tab', 'aria-selected': String(S.tab === id) }))), S.preview ? null : filters(), S.error ? h('div', { class: 'com-alert com-error', role: 'alert' }, S.error, btn('重试', () => void load())) : null, S.preview ? window.communicationsRenderAnalysis(S.preview, () => { S.preview = null; redraw(); }) : key ? detail() : S.tab === 'contacts' ? contacts() : S.tab === 'sync' ? sync() : overview()); return root; }
    window.addEventListener('pi-native-resume', () => { if (S.active)
        void load(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.active)
        void load(); });
    window.addEventListener('pi-gui-auth-failure', () => { deactivate(); if (ui.view === 'communications')
        document.querySelector('.communications')?.replaceChildren(h('p', { role: 'alert' }, '登录已失效，请重新登录')); });
    window.piRouteModules.register('communications', { render, deactivate, reload: () => load(), snapshotForTest: () => ({ stats: S.stats }) });
})();
