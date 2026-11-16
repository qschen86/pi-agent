/**
 * DeepSeek 计费时段（官方价目表 2026-10-23 核对）：
 *
 * - 峰时：UTC 01:00–04:00、06:00–10:00，周一至周五，排除中国法定节假日；
 * - 其余全部波谷：含工作日午休、夜间、周末与法定节假日全天；
 * - 波谷价 = 峰时 5 折，输入（缓存命中 / 未命中）与输出都打折。
 *
 * 时段按 UTC 定义，不看本机时区、不随夏令时变化；北京时间 = UTC+8，
 * 即峰时是北京工作日 09:00–12:00、14:00–18:00。
 *
 * 节假日表只收录已公布年份（目前 2026）。没有列到的年份一律按峰时处理：
 * 这样价格只会被估高，不会把峰时误判成波谷。
 */

export const PEAK_WINDOWS_UTC: ReadonlyArray<readonly [number, number]> = [[1, 4], [6, 10]];

/** 波谷价相对峰时的倍率。 */
export const OFF_PEAK_FACTOR = 0.5;

/** 中国法定节假日（含调休放假的整天）。调休上班的周末仍按周末算波谷，与官方口径一致。 */
export const CN_HOLIDAYS_2026: readonly string[] = [
  // 元旦
  "2026-01-01", "2026-01-02", "2026-01-03",
  // 春节
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  // 清明节
  "2026-04-04", "2026-04-05", "2026-04-06",
  // 劳动节
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  // 端午节
  "2026-06-19", "2026-06-20", "2026-06-21",
  // 中秋节
  "2026-09-25", "2026-09-26", "2026-09-27",
  // 国庆节
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"
];

export const CN_HOLIDAYS: ReadonlySet<string> = new Set(CN_HOLIDAYS_2026);

/** 某个时刻是否在峰时。holidays 可替换（测试用）；默认使用内置的中国法定节假日表。 */
export function isPeak(at: Date, holidays: ReadonlySet<string> = CN_HOLIDAYS): boolean {
  const ms = at.getTime();
  if (!Number.isFinite(ms)) return false;
  const weekday = at.getUTCDay(); // 0 = 周日
  if (weekday === 0 || weekday === 6) return false;
  if (holidays.has(at.toISOString().slice(0, 10))) return false;
  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  return PEAK_WINDOWS_UTC.some(([from, to]) => minutes >= from * 60 && minutes < to * 60);
}

export type Tariff = "peak" | "off-peak";

/** 页面和日志用的中文标签。 */
export function tariffLabel(at: Date, holidays: ReadonlySet<string> = CN_HOLIDAYS): Tariff {
  return isPeak(at, holidays) ? "peak" : "off-peak";
}

/**
 * 下一个波谷起点（毫秒）。已经是波谷时返回当前时刻。
 * 按分钟扫描，最多看 8 天：节假日与周末最多连休 9 天，超过就说明数据坏了。
 */
export function nextOffPeak(at: Date, holidays: ReadonlySet<string> = CN_HOLIDAYS): Date {
  const step = 60_000;
  let ms = Math.ceil(at.getTime() / step) * step;
  const limit = at.getTime() + 8 * 86_400_000;
  while (ms <= limit) {
    if (!isPeak(new Date(ms), holidays)) return new Date(ms);
    ms += step;
  }
  return new Date(at.getTime() + 8 * 86_400_000);
}

/** 给页面/说明用的一句话：峰时规则 + 北京时段。 */
export const PEAK_RULE_TEXT = "峰时（UTC 01:00–04:00、06:00–10:00，周一至周五，排除中国法定节假日；北京 09:00–12:00、14:00–18:00），其余全波谷，波谷价是峰时 5 折";
