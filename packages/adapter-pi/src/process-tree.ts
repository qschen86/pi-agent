/**
 * pi 进程树的收尾（ADR-0808）。
 *
 * 修复前超时或判定违规时只 SIGKILL pi 本身：它派生的 bash / node 子进程成了孤儿继续跑
 * （例如卡住的 npm test、后台起的服务）。而经过一层 shell 包装的实现（SRT）里，
 * 直接子进程是 shell，杀掉它 pi 都未必会死。
 *
 * 现在 pi 在自己的进程组里启动：超时、违规、正常退出之后都**整组**清理；
 * 另按父子关系补杀一遍（自己另开进程组的后代也跑不掉）。
 * 进程组脱离了终端的前台组，所以宿主收到 Ctrl-C / SIGTERM 时由这里负责把它们一起带走，
 * 然后按宿主原本的方式退出——不改变宿主自己的信号语义。
 */
import { spawnSync } from "node:child_process";

/** 按父子关系找出所有后代（广度优先）。 */
export function descendantPids(root: number): number[] {
  const ps = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  if (ps.status !== 0 || !ps.stdout) return [];
  const children = new Map<number, number[]>();
  for (const line of ps.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift() as number) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

const trySignal = (target: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(target, signal);
  } catch {
    /* 已经退出 */
  }
};

/** 整组 + 全部后代一起结束。 */
export function killProcessTree(pid: number): void {
  const descendants = descendantPids(pid);
  trySignal(-pid, "SIGKILL");
  for (const p of [pid, ...descendants]) trySignal(p, "SIGKILL");
}

/** 进程组里残留的进程（pi 已退出，它起的后台进程还在）。 */
export function killProcessGroup(pgid: number): void {
  trySignal(-pgid, "SIGKILL");
}

/* ------------------------- 宿主退出时一并带走 ------------------------- */

const liveGroups = new Set<number>();
const FORWARDED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const signalHandlers = new Map<NodeJS.Signals, () => void>();

function killAll(): void {
  for (const g of liveGroups) killProcessGroup(g);
  liveGroups.clear();
}

function install(): void {
  if (signalHandlers.size > 0) return;
  process.on("exit", killAll);
  for (const sig of FORWARDED) {
    const handler = (): void => {
      killAll();
      uninstall();
      // 没有别人接管这个信号：按默认行为重新投递（宿主照常退出）
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    signalHandlers.set(sig, handler);
    process.on(sig, handler);
  }
}

function uninstall(): void {
  process.removeListener("exit", killAll);
  for (const [sig, handler] of signalHandlers) process.removeListener(sig, handler);
  signalHandlers.clear();
}

/** 登记一个运行中的进程组；返回的函数在它结束时注销。 */
export function trackProcessGroup(pgid: number): () => void {
  liveGroups.add(pgid);
  install();
  return () => {
    liveGroups.delete(pgid);
    if (liveGroups.size === 0) uninstall();
  };
}
