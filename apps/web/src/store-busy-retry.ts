/**
 * 启动时抢原生会话存储的宿主锁（Lamport 面包店锁）：输的一方拿到 RT_STORE_BUSY，语义上「稍后重试」。
 * 部署切槽位时这一刻正好和还在服务的旧版本撞在一起（旧版此刻还在正常读写，线上 2026-11-27 就因此整次部署回滚：
 * 候选进程 new RuntimeStore 抛 RT_STORE_BUSY，进程 code=1 退出，监督进程判定「后端未就绪」）。
 * 构造 RuntimeStore / RuntimeSessionManager 都是同步的，所以重试放在外面：短间隔、有上限、只重试这一种错误。
 */
const RETRYABLE = "RT_STORE_BUSY";

export interface StoreBusyRetryOptions {
  /** 总预算（毫秒），默认 20000：旧版本每次请求都可能占住锁（读 bindings / usage 这种大文件），释放间隔不固定，
   *  但一次部署的就绪预算有 90s，这里留 20s 反复碰运气已经够；真正的冲突（admission.lock 残留）不重试。 */
  budgetMs?: number;
  /** 每次重试前等多久（毫秒），默认 250 */
  intervalMs?: number;
  /** 每次重试前的通知（默认吞掉，避免刷日志）；最后一次放弃时也会调用一次 */
  onRetry?: (attempt: number, error: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function isStoreBusy(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === RETRYABLE;
}

/** 只把 RT_STORE_BUSY 当作可重试；别的错误（文件损坏、原生宿主身份损坏等）立刻抛出。 */
export async function withStoreBusyRetry<T>(make: () => T, options: StoreBusyRetryOptions = {}): Promise<T> {
  const budgetMs = options.budgetMs ?? 20000;
  const intervalMs = options.intervalMs ?? 250;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return make();
    } catch (error) {
      if (!isStoreBusy(error) || Date.now() >= deadline) {
        if (isStoreBusy(error)) options.onRetry?.(attempt, error);
        throw error;
      }
      options.onRetry?.(attempt, error);
      await sleep(intervalMs);
    }
  }
}
