import { createRequire } from "node:module";
import type { DriverEvent, NativeContinuation } from "./driver.js";
import { bounded, LIMITS, stringifyInput } from "./redact.js";

// agy 1.5 的原生 protobuf 字段；仅解码本功能用到的结构，不从正文猜来源。
// steps: 14=user, 15=assistant, 101=notification, 132=tool。
const CONTINUATION_TOOL_NAME: Record<string, string> = {
  run_command: "命令",
  read_file: "读取文件",
  edit_file: "文件修改",
  write_file: "文件修改",
  delete_file: "文件修改",
  search_web: "联网",
};
function continuationToolName(raw: string): string {
  if (/^mcp_platform_browser(?:_[0-9a-f]+)?_browser$/.test(raw)) return "platform_browser.browser";
  return CONTINUATION_TOOL_NAME[raw] ?? (raw || "工具");
}
type Fields = Map<number, number | Buffer>;
function fields(bytes: Uint8Array): Fields {
  const b = Buffer.from(bytes), out: Fields = new Map();
  let i = 0;
  const varint = () => {
    let v = 0, factor = 1;
    for (let n = 0; n < 10; n++) {
      if (i >= b.length) throw new Error("truncated protobuf");
      const x = b[i++]!; v += (x & 127) * factor;
      if (!Number.isSafeInteger(v)) throw new Error("invalid protobuf integer");
      if (x < 128) return v;
      factor *= 128;
    }
    throw new Error("invalid protobuf varint");
  };
  while (i < b.length) {
    const tag = varint(), field = Math.floor(tag / 8), wire = tag % 8;
    if (!field) throw new Error("invalid protobuf tag");
    if (wire === 0) out.set(field, varint());
    else if (wire === 2) {
      const len = varint();
      if (i + len > b.length) throw new Error("truncated protobuf field");
      out.set(field, b.subarray(i, i + len)); i += len;
    } else if (wire === 1 || wire === 5) {
      i += wire === 1 ? 8 : 4;
      if (i > b.length) throw new Error("truncated protobuf fixed field");
    } else throw new Error("unsupported protobuf wire type");
  }
  return out;
}
const sub = (f: Fields, k: number): Fields => {
  const b = f.get(k);
  if (!Buffer.isBuffer(b)) throw new Error("missing protobuf message");
  return fields(b);
};
const text = (f: Fields, k: number): string => {
  const b = f.get(k);
  return Buffer.isBuffer(b) ? b.toString("utf8") : "";
};
interface Step { idx: number; step_type: number; status: number; metadata: Uint8Array; step_payload: Uint8Array }

/** A single read transaction: proof, projection and returned fingerprint must describe the same snapshot. */
export function readAntigravityContinuation(dbPath: string, sessionId: string, previous: string, toolCallIds: string[], endedAt: string): NativeContinuation | undefined {
  const match = /^s(\d+)i(-?\d+)$/.exec(previous);
  if (!match || !toolCallIds.length || !Number.isFinite(Date.parse(endedAt))) return undefined;
  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 2000; BEGIN");
    const rows = db.prepare("SELECT idx, step_type, status, metadata, step_payload FROM steps ORDER BY idx").all() as unknown as Step[];
    const count = Number(match[1]), max = Number(match[2]);
    const prefix = rows.filter(r => r.idx <= max), suffix = rows.filter(r => r.idx > max);
    if (prefix.length !== count || (prefix.at(-1)?.idx ?? -1) !== max) return undefined;
    let lastUser = prefix.length - 1;
    while (lastUser >= 0 && prefix[lastUser]!.step_type !== 14) lastUser--;
    if (lastUser < 0) return undefined;
    const turnRows = rows.slice(lastUser + 1), owned = new Set(toolCallIds), completed = new Set<string>();
    const taskRows = new Map(turnRows.filter(r => r.idx <= max && r.step_type === 132).map(r => [r.idx, r]));
    const events: DriverEvent[] = [];
    const groupOf = (r: Step) => text(fields(r.metadata), 12);
    const taskOf = (r: Step) => text(sub(fields(r.step_payload), 148), 1);
    const hasBackgroundTask = (r: Step): boolean => {
      try { return taskOf(r) === `${sessionId}/task-${r.idx}`; } catch { return false; }
    };
    const toolMetaOf = (r: Step): { callId: string; name: string; rawArgs: string } | undefined => {
      try {
        const meta = sub(fields(r.metadata), 4);
        const callId = text(meta, 1), name = text(meta, 2), rawArgs = text(meta, 3);
        return callId || name ? { callId, name, rawArgs } : undefined;
      } catch { return undefined; }
    };
    // IsDaemon=true 启动的是常驻支持进程（如本地测试服务），本身不预期自动结束并发送 task_notification；
    // 保留在 taskRows 里以便真正退出时仍可归属通知，但计算 pending 时忽略，避免永久锁死续聊。
    const isDaemonTask = (r: Step): boolean => {
      try { if (sub(fields(r.step_payload), 148).get(6) === 1) return true; } catch { /* fall through */ }
      try {
        const raw = text(sub(fields(r.metadata), 4), 3);
        if (raw && (JSON.parse(raw) as { IsDaemon?: unknown })?.IsDaemon === true) return true;
      } catch { /* ignore malformed or non-JSON tool args */ }
      return false;
    };
    const timeOf = (r: Step) => {
      const stamp = sub(fields(r.metadata), 1), seconds = stamp.get(1), nanos = stamp.get(2) ?? 0;
      if (typeof seconds !== "number" || typeof nanos !== "number") throw new Error("missing native timestamp");
      return new Date(seconds * 1000 + nanos / 1e6).toISOString();
    };
    const project = (r: Step, content: string, kind: DriverEvent["kind"], role: DriverEvent["role"]) => {
      const b = bounded(content, LIMITS.message);
      events.push({ key: `antigravity:step:${sessionId}:${r.idx}`, kind, role, text: b.text, partial: r.status !== 3,
        ...(b.truncated ? { truncated: b.truncated } : {}), ...(b.redactions ? { redactions: b.redactions } : {}),
        occurredAt: timeOf(r), source: "history", parserVersion: "antigravity-background@1", availability: "recorded" });
    };
    const projectTool = (r: Step, meta: { callId: string; name: string; rawArgs: string }) => {
      let inputText = meta.rawArgs;
      if (meta.rawArgs) {
        try {
          const parsed = JSON.parse(meta.rawArgs) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            inputText = typeof parsed["CommandLine"] === "string" ? parsed["CommandLine"]
              : typeof parsed["Path"] === "string" ? parsed["Path"]
              : stringifyInput(parsed);
          }
        } catch { /* keep raw args */ }
      }
      let outputText = "";
      try {
        const pf = fields(r.step_payload);
        if (pf.has(31)) {
          const err = sub(pf, 31);
          outputText = text(err, 2) || text(err, 3);
        }
        if (!outputText && pf.has(140)) {
          const p140 = sub(pf, 140);
          if (p140.has(2)) outputText = text(sub(p140, 2), 1);
        }
      } catch { /* tool may not have output yet */ }
      const inp = bounded(inputText, LIMITS.toolInput);
      const outp = bounded(outputText, LIMITS.toolOutput);
      const status = r.status === 3 ? "completed" : [4, 5, 7].includes(r.status) ? "failed" : "inProgress";
      const partial = r.status === 0 || r.status === 1 || r.status === 2 || (r.status === 6 && !isDaemonTask(r) && !hasBackgroundTask(r));
      events.push({
        key: `antigravity:step:${sessionId}:${r.idx}`, kind: "tool", nativeItemId: meta.callId,
        tool: { name: continuationToolName(meta.name), input: inp.text, ...(outputText ? { output: outp.text } : {}), status },
        partial, ...(outp.truncated ? { truncated: outp.truncated } : {}),
        ...(inp.redactions + outp.redactions ? { redactions: inp.redactions + outp.redactions } : {}),
        occurredAt: timeOf(r), source: "history", parserVersion: "antigravity-background@1", availability: "recorded"
      });
    };
    const notification = (r: Step): string | undefined => {
      if (r.step_type !== 101 || r.status !== 3) return undefined;
      const payload = sub(fields(r.step_payload), 114);
      if (text(payload, 3) !== "task_notification") return undefined;
      const n = sub(payload, 4), origin = sub(sub(n, 12), 1), call = sub(origin, 3);
      const idx = origin.get(2), task = typeof idx === "number" ? taskRows.get(idx) : undefined;
      const taskId = `${sessionId}/task-${idx}`;
      if (!task || text(n, 2) !== sessionId || text(n, 3) !== taskId || text(origin, 1) !== sessionId ||
          taskOf(task) !== taskId || !owned.has(text(call, 1)) || !groupOf(r)) return undefined;
      completed.add(taskId);
      return text(payload, 1);
    };
    // Runtime-generated reminders are part of a proven execution group, not a
    // new conversation. Require typed metadata and native session/step identity.
    const ownedReminder = (r: Step, group: string): boolean => {
      try {
        const meta = fields(r.metadata), identity = sub(meta, 20), payload = sub(fields(r.step_payload), 114);
        return !!group && groupOf(r) === group && r.status === 3 && meta.get(3) === 5 &&
          identity.get(2) === r.idx && text(identity, 4) === sessionId && text(payload, 3) === "work_efficiently_reminder";
      } catch { return false; }
    };
    // A baseline may already include a completion notification while its response/tool chain is still running.
    let group = "", projectGroup = false;
    for (const r of prefix.slice(lastUser + 1)) {
      if (r.step_type === 101) {
        if (ownedReminder(r, group)) continue;
        try {
          const content = notification(r);
          group = content !== undefined ? groupOf(r) : "";
          projectGroup = !!group && Date.parse(timeOf(r)) >= Date.parse(endedAt);
          if (projectGroup) project(r, content!, "notice", "system");
        } catch { group = ""; projectGroup = false; }
      } else if (r.step_type === 15 && group && groupOf(r) === group) {
        if (projectGroup) {
          const content = text(sub(fields(r.step_payload), 20), 1);
          if (content.trim()) project(r, content, "message", "assistant");
        }
      } else if (r.step_type === 132 && group && groupOf(r) === group) {
        const meta = toolMetaOf(r);
        if (meta?.callId) owned.add(meta.callId);
        if (projectGroup && meta) projectTool(r, meta);
      } else { group = ""; projectGroup = false; }
    }
    for (const r of suffix) {
      if (r.step_type === 101) {
        if (ownedReminder(r, group)) continue;
        const value = notification(r);
        if (value === undefined) return undefined;
        group = groupOf(r);
        project(r, value, "notice", "system");
      } else if (r.step_type === 15 && group && groupOf(r) === group) {
        const content = text(sub(fields(r.step_payload), 20), 1);
        if (![0, 1, 2, 3].includes(r.status)) return undefined;
        if (content.trim()) project(r, content, "message", "assistant");
      } else if (r.step_type === 132 && group && groupOf(r) === group) {
        if (![0, 1, 2, 3, 4, 5, 6, 7].includes(r.status)) return undefined;
        const meta = toolMetaOf(r);
        if (!meta) return undefined;
        taskRows.set(r.idx, r);
        if (meta.callId) owned.add(meta.callId);
        projectTool(r, meta);
      } else return undefined; // includes every user message, foreign-group tool call, and unknown step type
    }
    const last = rows.at(-1);
    const active = !!group && !!last && (
      last.step_type === 101 ||
      (last.step_type === 15 && [0, 1, 2].includes(last.status)) ||
      (last.step_type === 132 && ([0, 1, 2].includes(last.status) || (last.status === 6 && !isDaemonTask(last) && !hasBackgroundTask(last))))
    );
    const pending = [...taskRows.values()].some(r => {
      try { return !isDaemonTask(r) && taskOf(r) === `${sessionId}/task-${r.idx}` && !completed.has(taskOf(r)); } catch { return false; }
    });
    return { fingerprint: `s${rows.length}i${last?.idx ?? -1}`, events, active, pending,
      toolCallIds: turnRows.filter(r => r.step_type === 132).map(r => toolMetaOf(r)?.callId).filter((id): id is string => !!id) };
  } catch { return undefined; } // Missing schema, unknown protocol or malformed evidence never permits a write.
  finally { try { db?.close(); } catch { /* no open connection */ } }
}
