"use strict";
(() => {
    const sent = new Set();
    const beijing = value => value ? new Date(value).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false})+' 北京时间' : '未知';
    const masked = v => String(v).replace(/\+?[0-9][0-9\s()\-]{4,}[0-9]/g, '隐藏号码');
    window.communicationsBuildAnalysis = (stats, filter, includeNames = true) => {
        const t = stats.totals || {}, calls = (t.incoming || 0) + (t.outgoing || 0) + (t.missed || 0) + (t.rejected || 0) + (t.other || 0), seconds = (t.incomingSeconds || 0) + (t.outgoingSeconds || 0);
        const scope = structuredClone(filter);
        const ready = kind => Object.values(stats.coverage || {}).some(c => c[kind]?.lastSuccess);
        const months = new Map();
        for (const day of stats.days || []) {
            const month=day.date.slice(0,7), row=months.get(month)||{calls:0,received:0,sent:0};
            row.calls+=(day.incoming||0)+(day.outgoing||0)+(day.missed||0)+(day.rejected||0)+(day.other||0);row.received+=day.received||0;row.sent+=day.sent||0;months.set(month,row);
        }
        const trend=[...months].sort(([a],[b])=>a.localeCompare(b)).slice(-12).map(([month,row])=>`${month}：通话 ${row.calls} 次，短信收到 ${row.received} 条、发出 ${row.sent} 条`).join('\n');
        const names = (stats.rankings || []).slice(0, 20).map((r, i) => `${includeNames && r.names?.length ? masked(r.names.join(' / ')) : `联系人 ${i + 1}`} ${r.calls} 次`).join('；');
        const coverage = Object.entries(stats.coverage || {}).flatMap(([device, kinds]) => ['contacts', 'calls', 'sms'].map(k => `${device} / ${k}：${kinds[k] ? `状态 ${kinds[k].state || '未知'}，最近尝试 ${beijing(kinds[k].lastAttempt)}；成功同步于 ${kinds[k].lastSuccess?beijing(kinds[k].lastSuccess):'从未'}，范围 ${kinds[k].fromDate || kinds[k].retainedFrom || '系统保留记录'} 至 ${kinds[k].throughDate || '未知'}` : '尚未同步，数据缺失'}`)).join('\n');
        const retention = Object.entries(stats.coverage || {}).flatMap(([device, kinds]) => ['calls', 'sms'].flatMap(k => { const m = kinds[k]?.collectedAtByDate || {}; const old = Object.entries(m).filter(([, time]) => time !== kinds[k]?.lastSuccess); return old.length ? [`${device} / ${k}：${old.length} 天为历史保留统计，采集时间从 ${beijing(old.map(([, time]) => time).sort()[0])} 至 ${beijing(old.map(([, time]) => time).sort().at(-1))}`] : []; })).join('\n');
        const text = `请根据以下通讯统计，整理联系趋势与变化，指出值得关注的统计现象。\n\n设备：${scope.deviceId === 'all' ? '全部设备计数之和（未跨设备去重）' : scope.deviceId}\n范围：${scope.from || '全部已同步记录'} 至 ${scope.through || '最近同步日期'}，按北京时间划分日期。\n\n${ready('contacts')?`联系人 ${t.contacts || 0} 人，共 ${t.numbers || 0} 个号码。`:'联系人：尚未成功同步，数量未知。'}\n${ready('calls')?`通话 ${calls} 次，已接通时长 ${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分。`:'通话：尚未成功同步，次数与时长未知。'}\n${ready('sms')?`短信收到 ${t.received || 0} 条、发出 ${t.sent || 0} 条。`:'短信：尚未成功同步，数量未知。'}\n常联系：${names || '暂无数据'}。\n\n月度趋势（最多列出最近 12 个月，汇总覆盖所选全部范围）：\n${trend||'暂无按日统计'}\n\n覆盖与缺失：\n${coverage || '尚无成功同步记录'}\n${retention}\n\n统计不能代表关系亲疏，不包含短信正文，不要推断短信内容。请说明缺失数据对判断的影响。`;
        return Object.freeze({ id: crypto.randomUUID(), revision: stats.revision, text, filter: Object.freeze(scope), includeNames });
    };
    window.communicationsOpenAnalysis = async (preview) => {
        if (sent.has(preview.id))
            return false;
        sent.add(preview.id);
        let handed = false;
        try {
            if (typeof rtStartNewSession !== 'function' && window.piRouteModules?.has('rt-new'))
                await window.piRouteModules.ensure('rt-new');
            if (typeof rtStartNewSession !== 'function')
                throw new Error('新建会话暂不可用，请重试');
            const draft = typeof rtImageDraft === 'function' ? rtImageDraft('new') : null;
            if (draft && (draft.text?.trim() || draft.images?.length || draft.pending)) {
                if (draft.pending)
                    throw new Error('已有会话正在创建，请等待完成');
                if (!confirm('新建会话中已有草稿。是否替换为这次通讯统计？取消会保留原草稿。'))
                    return false;
                if (typeof rtClearImageDraft !== 'function')
                    throw new Error('无法安全替换已有草稿');
                rtClearImageDraft('new');
            }
            rtStartNewSession(preview.text);
            handed = true;
            return true;
        }
        finally {
            if (!handed)
                sent.delete(preview.id);
        }
    };
    window.communicationsRenderAnalysis = (preview, close) => h('section', { class: 'com-panel com-preview' }, h('div', { class: 'com-panel-title' }, h('h2', {}, '用 AI 看看联系变化'), h('button', { type: 'button', class: 'btn', onclick: close }, '返回')), h('p', { class: 'com-meta' }, '先确认发送内容，再到会话中选择模型。'), h('div', { class: 'com-scope' }, h('span', {}, preview.filter.deviceId === 'all' ? '全部设备' : preview.filter.deviceId), h('span', {}, '北京时间'), h('span', {}, '冻结的统计快照')), h('div', { class: 'com-preview-body' }, preview.text), h('div', { class: 'com-note' }, '仅带入以上统计，完整号码已隐藏；不附全量通讯录。最终发送后，由你选择的 AI 模型处理。'), h('div', { class: 'com-preview-actions' }, h('span', { class: 'com-meta' }, '不会自动发送，你可以继续编辑。'), h('button', { type: 'button', class: 'btn primary', onclick: async (e) => { const button = e.currentTarget; button.disabled = true; try {
            if (!await window.communicationsOpenAnalysis(preview))
                button.disabled = false;
        }
        catch (error) {
            button.disabled = false;
            const alert = document.createElement('p');
            alert.setAttribute('role', 'alert');
            alert.textContent = error.message;
            button.parentElement.append(alert);
        } } }, '带入新会话')));
    window.piRouteModules?.register('communications-ai', {});
})();
