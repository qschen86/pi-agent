/**
 * 本地验证引擎的宿主侧服务实现：供 apps/web/src/main.ts 与测试装配，复用 scripts/verify/api.mjs。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  cancelVerifyJob,
  describeVerifyJob,
  listVerifyJobs,
  mustJob,
  readVerifyLogs,
  readVerifyReport,
  startVerifyJob,
  verifyBySession,
  verifyForSession,
  verifySignature,
} from "../../../scripts/verify/api.mjs";
import { verifyDirs, type VerifyDirs } from "../../../scripts/verify/job-store.mjs";
import { mountVerifyRoutes, type SessionVerifyView, type VerifyService } from "./verify-routes.js";

export { mountVerifyRoutes, type SessionVerifyView, type VerifyService };

export function createVerifyService(options: { root?: string; now?: () => number } = {}): VerifyService & { readonly dirs: VerifyDirs } {
  const root = options.root ?? process.env["PI_AGENT_GUI_ROOT"] ?? join(homedir(), ".pi-agent-gui");
  const dirs = verifyDirs(root);
  const now = options.now ?? Date.now;
  return {
    dirs,
    start: (input) => startVerifyJob(dirs, input, { now }),
    status: (id) => describeVerifyJob(dirs, mustJob(dirs, id), { now }),
    report: (id, opts) => readVerifyReport(dirs, id, { checkCurrent: !!opts?.checkCurrent, now }),
    logs: (id, opts) => readVerifyLogs(dirs, id, opts),
    cancel: (id, opts) => cancelVerifyJob(dirs, id, { by: opts?.by ?? "web", reason: opts?.reason ?? null, now }),
    list: (opts) => listVerifyJobs(dirs, opts),
    signature: () => verifySignature(dirs),
    bySession: () => verifyBySession(dirs, { now }),
    forSession: (sessionId) => verifyForSession(dirs, sessionId, { now }),
  };
}
