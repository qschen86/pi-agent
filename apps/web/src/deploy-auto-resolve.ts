/**
 * 「提交并在空闲时部署」的冲突自动解决：冲突不直接交给人，先让请求部署的会话自己把 main 合进来解决，
 * 那一轮正常结束后自动重新登记部署。只有自动处理不了时才停下来，标「需要人处理」并说明原因：
 * - 会话放弃了合并（按提示 git merge --abort 并说明要人取舍），或留下未解决的冲突；
 * - 解决冲突的那一轮失败 / 中断 / 结果未知（人主动停止那一轮 = 人接手，静默结束自动处理）；
 * - 连续 AUTO_RESOLVE_MAX 次仍冲突（例如 main 一直在变）。
 *
 * 冲突来源有两处，状态都记在 when-idle/auto-resolve/<会话>.json（见 scripts/deploy-when-idle.mjs）：
 * - 登记时变基到 main 冲突（本模块 begin，发出那一轮）；
 * - 守候进程部署前集成冲突（守候进程自己发出那一轮并写状态）。
 * 之后都由本模块在会话那一轮结束时（manager 的 session 事件，及启动时补查）接手。
 */
import { AUTO_RESOLVE_MAX, autoResolveKey, autoResolvePrompt } from "../../../scripts/deploy-when-idle.mjs";
import type { RuntimeSessionManager, SessionBinding } from "@pi-agent/runtime-sessions";
import { DeployConflictError, type AutoResolveState, type DeployQueue } from "./deploy-queue.js";

const ACTIVE = ["creating", "running", "waiting-input", "stopping"];
const PENDING_TURN = ["queued", "running", "waiting-input"];
const ACTOR = "deploy-auto-resolve";

export interface DeployAutoResolver {
  /** 登记时冲突：给会话发解决冲突的一轮；manual = 人点的部署（次数从头算） */
  begin(session: SessionBinding, conflict: DeployConflictError, opts: { manual: boolean }): Promise<AutoResolveState>;
  /** 会话状态变化时检查：解决冲突那一轮结束了就接着处理 */
  check(platformSessionId: string): Promise<void>;
  stop(): void;
}

export function createDeployAutoResolver(mgr: RuntimeSessionManager, queue: DeployQueue, opts: { branch?: string } = {}): DeployAutoResolver {
  const branch = opts.branch ?? "main";
  const inFlight = new Set<string>();

  const needsHuman = (prev: Omit<AutoResolveState, "at">, reason: string): AutoResolveState => {
    const { operationId: _op, requestId: _rq, ...rest } = prev;
    const st = queue.saveAutoResolve({ ...rest, phase: "needs-human", reason });
    mgr.store.audit({ type: "deploy-auto-resolve", platformSessionId: prev.session, phase: "needs-human", reason, attempts: prev.attempts });
    return st;
  };

  const begin = async (s: SessionBinding, conflict: DeployConflictError, { manual }: { manual: boolean }): Promise<AutoResolveState> => {
    const pid = s.platformSessionId;
    const prev = manual ? undefined : queue.autoResolveState(pid);
    const attempt = (prev?.attempts ?? 0) + 1;
    const base = { session: pid, attempts: attempt, max: AUTO_RESOLVE_MAX, conflicts: conflict.conflicts, stage: "request" as const, head: conflict.head, branch };
    if (attempt > AUTO_RESOLVE_MAX) return needsHuman({ ...base, attempts: prev!.attempts, phase: "needs-human" }, `已自动解决 ${AUTO_RESOLVE_MAX} 次仍和 ${branch} 冲突：${conflict.conflicts.join("、") || conflict.message}`);
    const cur = mgr.store.binding(pid) ?? s;
    try {
      const r = await mgr.sendTurn(pid, {
        idempotencyKey: autoResolveKey(pid, attempt),
        prompt: autoResolvePrompt({ branch, conflicts: conflict.conflicts, attempt, stage: "request" }),
        expectedRevision: cur.bindingRevision
      }, ACTOR);
      mgr.store.audit({ type: "deploy-auto-resolve", platformSessionId: pid, phase: "resolving", attempts: attempt, conflicts: conflict.conflicts, operationId: r.operation.operationId });
      return queue.saveAutoResolve({ ...base, phase: "resolving", operationId: r.operation.operationId });
    } catch (e) {
      return needsHuman({ ...base, attempts: prev?.attempts ?? 0, phase: "needs-human" }, `和 ${branch} 冲突（${conflict.conflicts.join("、")}），但没能让会话去解决：${(e as Error).message}`);
    }
  };

  const check = async (pid: string): Promise<void> => {
    const st = queue.autoResolveState(pid);
    if (!st) return;
    const b = mgr.store.binding(pid);
    if (!b) return;
    if (st.phase === "needs-human") {
      // 人看到「部署待处理」后继续了会话（发了新消息 / 开了新一轮）：人已接手，这个标记作废，
      // 列表上只剩会话本身的状态（进行中 / 已完成等）。要部署时人再点一次部署就行。
      if (b.turns.some((t) => Date.parse(t.startedAt ?? "") > Date.parse(st.at))) {
        queue.clearAutoResolve(pid);
        mgr.store.audit({ type: "deploy-auto-resolve", platformSessionId: pid, phase: "resumed-by-human", attempts: st.attempts });
        mgr.emit("directory", {});
      }
      return;
    }
    if (st.phase !== "resolving" || inFlight.has(pid)) return;
    const turn = b.turns.find((t) => t.operationId === st.operationId);
    if (!turn) {
      // 守候进程刚发出、本地还没看到这一轮；超过一小时仍找不到就交给人
      if (Date.now() - Date.parse(st.at) > 3600_000) needsHuman(st, "找不到让会话解决冲突的那一轮");
      return;
    }
    if (PENDING_TURN.includes(turn.status)) return;
    if (turn.status === "cancelled") {
      // 人停下了那一轮：人已接手，不再自动部署
      queue.clearAutoResolve(pid);
      mgr.store.audit({ type: "deploy-auto-resolve", platformSessionId: pid, phase: "stopped-by-human", attempts: st.attempts });
      return;
    }
    if (turn.status !== "completed") { needsHuman(st, `让会话解决冲突的那一轮没有正常结束（${turn.statusReason ?? turn.status}）`); return; }
    // 排队消息可能紧接着开始下一轮：等会话再次空闲
    if (ACTIVE.includes(b.status)) return;
    inFlight.add(pid);
    try {
      const info = await queue.info(b);
      if (!info.eligible || !info.main || !info.worktree) { needsHuman(st, info.reason ?? "这个会话现在不能从页面部署"); return; }
      const wt = info.worktree;
      if (wt.changes.some((c) => c.status.includes("U") || c.status === "AA" || c.status === "DD")) { needsHuman(st, "会话留下了未解决的冲突，合并没有完成"); return; }
      if (st.head && wt.head === st.head && !wt.changes.length) { needsHuman(st, `会话没有完成合并（多半是需要人来取舍，见它最后的回复）：${st.conflicts.join("、")}`); return; }
      try {
        const r = await queue.request({ session: b, expectedSha: info.main.sha, auto: true });
        mgr.noteDeployRequest(pid, ACTOR, r);
        queue.saveAutoResolve({ ...st, phase: "queued", requestId: r.request.id, operationId: undefined });
        mgr.store.audit({ type: "deploy-auto-resolve", platformSessionId: pid, phase: "queued", attempts: st.attempts, sha: r.request.sha });
        mgr.emit("session", { platformSessionId: pid });
      } catch (e) {
        if (e instanceof DeployConflictError) await begin(b, e, { manual: false });
        else needsHuman(st, `解决冲突后重新提交部署失败：${(e as Error).message}`);
      }
    } finally { inFlight.delete(pid); }
  };

  const onSession = (p: { platformSessionId?: string }) => { if (p?.platformSessionId) void check(p.platformSessionId).catch((e) => console.error("冲突自动解决出错：", e)); };
  mgr.on("session", onSession);
  // 服务重启期间结束的那一轮：启动后补查一遍
  const boot = setTimeout(() => { for (const b of mgr.store.allBindings()) onSession({ platformSessionId: b.platformSessionId }); }, 5_000);
  boot.unref?.();
  return { begin, check, stop: () => { clearTimeout(boot); mgr.off("session", onSession); } };
}
