import { execFile } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Read-side subprocesses yield to HTTP/SSE; concurrent identical reads share only their in-flight work. */
export function createDeployReadCommands() {
  type Outcome = { code: number | null; stdout?: string };
  const pending = new Map<string, Promise<Outcome>>();
  let active = 0;
  const waiting: Array<() => void> = [];
  // code: 0 = success, a positive number = the command's own exit status, null = it never ran normally (spawn error, timeout, signal).
  const exec = (file: string, args: string[], timeout = 10_000): Promise<Outcome> => {
    const key = JSON.stringify([file, args]);
    const previous = pending.get(key);
    if (previous) return previous;
    const result = (async () => {
      if (active >= 4) await new Promise<void>((resolve) => waiting.push(resolve));
      else active++;
      try {
        return await new Promise<Outcome>((resolve) => {
          try {
            execFile(file, args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
              if (!error) return resolve({ code: 0, stdout: stdout.trim() });
              const code = (error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean }).code;
              resolve({ code: typeof code === "number" && !(error as { killed?: boolean }).killed ? code : null });
            });
          } catch { resolve({ code: null }); }
        });
      } finally {
        const next = waiting.shift();
        if (next) next(); else active--;
      }
    })();
    pending.set(key, result);
    void result.finally(() => pending.delete(key));
    return result;
  };
  // 同一条在途命令返回同一个 promise（调用方靠它合并并发读）。
  const reading = new Map<string, Promise<string | undefined>>();
  const run = (file: string, args: string[], timeout = 10_000): Promise<string | undefined> => {
    const key = JSON.stringify([file, args]);
    const previous = reading.get(key);
    if (previous) return previous;
    const result = exec(file, args, timeout).then((o) => o.stdout);
    reading.set(key, result);
    void result.finally(() => reading.delete(key));
    return result;
  };
  const gitArgs = (cwd: string, args: string[]) => ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args];
  const git = (cwd: string, ...args: string[]) => run("git", gitArgs(cwd, args));
  // 两个完整提交号之间的祖先关系永远不变：答案（是 / 不是）记住，不再起 git。
  // 10-24 部署排队 12 条时，会话列表和部署状态每读一次要起 44–53 个 `git merge-base`，
  // 几个页面同时轮询、机器又在跑测试时把事件循环拖到 1–2 秒一卡。出错（提交还不在仓库里、超时）不记。
  const ancestry = new Map<string, boolean>();
  const ANCESTRY_LIMIT = 4096;
  const FULL_SHA = /^[a-f0-9]{40}$/;
  const ancestor = async (repo: string, a: string, b: string): Promise<boolean> => {
    if (a === b) return true;
    const cacheable = FULL_SHA.test(a) && FULL_SHA.test(b), key = `${repo}\0${a}\0${b}`;
    const known = cacheable ? ancestry.get(key) : undefined;
    if (known !== undefined) return known;
    const { code } = await exec("git", gitArgs(repo, ["merge-base", "--is-ancestor", a, b]));
    if (cacheable && (code === 0 || code === 1)) {
      if (ancestry.size >= ANCESTRY_LIMIT) ancestry.delete(ancestry.keys().next().value as string);
      ancestry.set(key, code === 0);
    }
    return code === 0;
  };
  const commonDir = async (cwd: string): Promise<string | undefined> => {
    const value = await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
    try { return value ? realpathSync(value) : undefined; } catch { return undefined; }
  };
  const live = async (root = process.env["PI_AGENT_GUI_ROOT"] || join(homedir(), ".pi-agent-gui")): Promise<string | undefined> => {
    try {
      const marker = JSON.parse(readFileSync(join(root, "control/web-supervisor.json"), "utf8"));
      if (marker.protocol === 2) {
        let alive = false;
        try { process.kill(marker.pid, 0); alive = true; } catch { /* unavailable supervisor */ }
        return alive && !marker.running?.dead && /^[a-f0-9]{40}$/.test(marker.running?.sha ?? "") ? marker.running.sha : undefined;
      }
    } catch { /* legacy installation */ }
    try { return await git(realpathSync(join(root, "current")), "rev-parse", "HEAD"); } catch { return undefined; }
  };
  // Match the controller's rollback validation without blocking HTTP on Git.
  const rollbackTarget = async (root: string) => {
    try {
      const currentLive = await live(root), current = realpathSync(join(root, "current"));
      const blue = realpathSync(join(root, "slots/blue"));
      const target = current === blue ? "green" : current === realpathSync(join(root, "slots/green")) ? "blue" : undefined;
      if (!currentLive || !target || await git(current, "rev-parse", "HEAD") !== currentLive) return undefined;
      const slot = join(root, "slots", target), sha = await git(slot, "rev-parse", "HEAD");
      if (!sha || sha === currentLive || readFileSync(join(slot, ".deploy-ok"), "utf8").trim() !== sha) return undefined;
      return { sha, live: currentLive, subject: await git(slot, "log", "-1", "--format=%s", sha) ?? "" };
    } catch { return undefined; }
  };
  // ps is global, but this cache is local to one queue. Share an in-flight sample too.
  let vitestSample: { at: number; value: Promise<number> } | undefined;
  const vitestCount = (): Promise<number> => {
    if (vitestSample && Date.now() - vitestSample.at < 5000) return vitestSample.value;
    const value = run("ps", ["-Ao", "command"], 3000).then((s) => (s ?? "").split("\n").filter((line) => /vitest/.test(line) && !/deploy-when-idle/.test(line)).length);
    vitestSample = { at: Date.now(), value };
    return value;
  };
  return { git, ancestor, commonDir, live, rollbackTarget, vitestCount };
}

/** Async counterpart of scripts/deploy-when-idle.mjs planDeploy; parity is tested on branched histories. */
export async function planDeployRead<T extends { sha: string }>(requests: T[], live: string | undefined, ancestor: (a: string, b: string) => Promise<boolean>) {
  const done: T[] = [], pending: T[] = [];
  for (const q of requests) (live && await ancestor(q.sha, live) ? done : pending).push(q);
  if (!pending.length) return { done, target: undefined, covered: [] as T[] };
  const first = pending[0]!;
  let target = first.sha;
  for (const q of [...pending].reverse()) if (await ancestor(first.sha, q.sha)) { target = q.sha; break; }
  const covered: T[] = [];
  for (const q of pending) if (await ancestor(q.sha, target)) covered.push(q);
  return { done, target, covered };
}
