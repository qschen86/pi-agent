/**
 * 检索结果的来源类型提示（平台维护，只作挑选阅读的参考，不代表内容可信）：
 * - government：政府、监管机构、交易所与国际组织的官网——平台能从域名确定地认出来；
 * - media：平台名单里的权威媒体。
 * 企业自己的官网（例如某家公司的产品页）平台从域名无法可靠判断，由执行 Agent 按检索词与结果判断，
 * 选它时写明依据（basis=official），记入来源台账供人与验收助手复核。
 */
export type SourceKind = "government" | "media";

export const SOURCE_KINDS_VERSION = "source-kinds@2026-09-27";

/** 政府与公共机构的域名后缀 */
const GOVERNMENT_SUFFIX = [
  /\.gov$/, /\.gov\.[a-z]{2}$/, /\.gob\.[a-z]{2}$/, /\.gouv\.fr$/, /\.go\.(jp|kr|th|id)$/, /\.gc\.ca$/, /\.europa\.eu$/, /\.mil$/
];

/** 不在政府域名下的监管机构、交易所与国际组织 */
const REGULATORS = [
  "sfc.hk", "hkex.com.hk", "hkmc.com.hk", "fca.org.uk", "bis.org", "imf.org", "worldbank.org", "oecd.org", "un.org", "who.int", "fsb.org", "iosco.org",
  "sse.com.cn", "szse.cn", "nasdaq.com", "nyse.com", "sgx.com"
];

/** 权威媒体（综合、财经与科技）；名单可扩展，改动时同步更新版本号 */
const MEDIA = [
  "reuters.com", "bloomberg.com", "ft.com", "wsj.com", "economist.com", "nytimes.com", "apnews.com", "bbc.com", "bbc.co.uk", "cnbc.com",
  "nikkei.com", "theguardian.com", "forbes.com", "techcrunch.com",
  "scmp.com", "thestandard.com.hk", "hket.com", "hkej.com", "mingpao.com", "hk01.com", "rthk.hk", "news.now.com", "tvb.com", "orangenews.hk", "am730.com.hk",
  "caixin.com", "yicai.com", "21jingji.com", "jiemian.com", "thepaper.cn", "xinhuanet.com", "people.com.cn", "chinadaily.com.cn", "cls.cn", "stcn.com", "36kr.com"
];

const under = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** 按域名给出来源类型提示；认不出返回 undefined（不等于不可信，只是平台不作判断） */
export function sourceKindOf(host: string): SourceKind | undefined {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (GOVERNMENT_SUFFIX.some((re) => re.test(h)) || REGULATORS.some((d) => under(h, d))) return "government";
  if (MEDIA.some((d) => under(h, d))) return "media";
  return undefined;
}
