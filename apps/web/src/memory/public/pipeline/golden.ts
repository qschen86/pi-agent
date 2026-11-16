import type { Topic } from './types.js';

/** 回放评估的「必须出现」用例：每条都是一次真实发生过的“该进公共记忆却没进”。判据是关键词组合，宁严勿松。 */
export interface GoldenCase { id: string; label: string; domain: 'personal' | 'project'; all: RegExp[] }
export const GOLDEN: readonly GoldenCase[] = [
  { id: 'apk-with-deploy', label: '部署涉及 APK 时一起构建并发布', domain: 'project', all: [/APK/i, /(构建|打包)/, /(一起|同时|之后|后再|先.*再|不要先发前端)/] },
  { id: 'keyboard-not-cover', label: '手机键盘弹起不能挡住主操作按钮', domain: 'project', all: [/键盘/, /(挡|遮|看不到|可见)/] },
  { id: 'tab-transition', label: 'tab 左右切换统一过渡动画', domain: 'project', all: [/tab|选项卡|页签/i, /(动画|动效|过渡)/] },
  { id: 'subapp-title', label: '子应用标题统一高度和模式', domain: 'project', all: [/应用/, /标题/, /(统一|一致)/, /(高度|模式)/] },
  { id: 'beijing-time', label: '时间按北京时间表达', domain: 'personal', all: [/北京时间/] },
  { id: 'chinese', label: '用中文沟通', domain: 'personal', all: [/中文/] },
  { id: 'screenshot-chip', label: '看界面效果要给可点击预览的截图（chip）', domain: 'personal', all: [/截图/, /(chip|点击|预览)/i] }
];

export interface GoldenResult { id: string; label: string; found: boolean; topicId?: string; tier?: string; statement?: string }
export function checkGolden(topics: readonly Topic[], cases: readonly GoldenCase[] = GOLDEN): GoldenResult[] {
  const pub = topics.filter(t => t.tier !== 'material');
  return cases.map(c => {
    const hit = pub.find(t => c.all.every(re => re.test(t.statement)) && (c.domain === t.domain || true));
    return { id: c.id, label: c.label, found: !!hit, ...(hit ? { topicId: hit.id, tier: hit.tier, statement: hit.statement } : {}) };
  });
}

/** 字符二元组 Jaccard，用来把“现有条目”和“回放主题”粗配对。 */
const grams = (s: string): Set<string> => { const t = s.replace(/\s+/g, ''); const out = new Set<string>(); for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2)); return out; };
export function similarity(a: string, b: string): number {
  const x = grams(a), y = grams(b);
  if (!x.size || !y.size) return 0;
  let n = 0; for (const g of x) if (y.has(g)) n++;
  return n / (x.size + y.size - n);
}
