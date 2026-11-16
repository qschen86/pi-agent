import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { bounded, redact, RuntimeError } from "@pi-agent/runtime-sessions";
import type { RuntimeSessionManager } from "@pi-agent/runtime-sessions";
import type { Room } from "./room-types.js";
import { sourceLabel } from "./room-prompts.js";

export function roomSnapshotRoot(room: Pick<Room, "workspace" | "roomId">): string { return join(room.workspace, ".pi-room", room.roomId); }
export function checkSnapshotPath(workspace: string, roomId: string, existing = false): void {
  const base = join(workspace, ".pi-room"), root = join(base, roomId);
  for (const path of [base, root, join(root, "members")]) {
    if (existsSync(path) || (() => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } })()) {
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new RuntimeError("快照路径必须是平台管理的真实目录", 409, "ROOM_SNAPSHOT");
    }
  }
  if (existsSync(root) && (!existing || !existsSync(join(root, ".room-owner")) || readFileSync(join(root, ".room-owner"), "utf8") !== roomId)) throw new RuntimeError("快照目录不属于此群聊，拒绝覆盖", 409, "ROOM_SNAPSHOT");
}
function atomicReadonly(path: string, text: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new RuntimeError("快照文件不能是符号链接", 409, "ROOM_SNAPSHOT");
  const tmp = `${path}.tmp-${randomUUID()}`; writeFileSync(tmp, redact(text).text, { mode: 0o444 }); chmodSync(tmp, 0o444); renameSync(tmp, path);
}
/** 投递已结束：这一轮可以放出独立作答的回复 */
export const ROUND_DONE = ["completed", "failed", "unknown", "cancelled"];
/**
 * 独立作答：@ 了 2 个以上成员的轮次，在所有投递结束前不放出这一轮的回复，
 * 防止后答的成员从快照里读到先答者的答案。返回要隐藏的群聊消息号与各成员要隐藏的轮次。
 */
export function openRoundsHidden(room: Pick<Room, "messages">): { messages: Set<number>; turns: Map<string, Set<number>> } {
  const messages = new Set<number>(), turns = new Map<string, Set<number>>();
  for (const m of room.messages) {
    if (m.kind !== "human" || m.deliveries.length < 2 || m.deliveries.every((d) => ROUND_DONE.includes(d.status))) continue;
    for (const r of room.messages) if (r.replyTo === m.seq) messages.add(r.seq);
    for (const d of m.deliveries) if (d.turnNo) { const set = turns.get(d.memberId) ?? new Set<number>(); set.add(d.turnNo); turns.set(d.memberId, set); }
  }
  return { messages, turns };
}
export function writeRoomSnapshot(room: Room, mgr: RuntimeSessionManager): void {
  if (room.archived) return;
  const root = roomSnapshotRoot(room); checkSnapshotPath(room.workspace, room.roomId, true);
  mkdirSync(join(root, "members"), { recursive: true }); atomicReadonly(join(root, ".room-owner"), room.roomId);
  // 本地排除，支持子目录和 linked worktree 的 git-path。
  try {
    const gitRoot = execFileSync("git", ["-C", room.workspace, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const exclude = execFileSync("git", ["-C", gitRoot, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
    const before = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    const rule = `${room.workspace === gitRoot ? "" : room.workspace.slice(gitRoot.length)}/.pi-room/`;
    if (!before.split("\n").includes(rule)) { mkdirSync(join(exclude, ".."), { recursive: true }); writeFileSync(exclude, `${before}${before.endsWith("\n") || !before ? "" : "\n"}${rule}\n`); }
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "EACCES" || (e as NodeJS.ErrnoException).code === "EPERM") throw e; }
  const anonymous = room.settings.attribution === "anonymous";
  const hidden = openRoundsHidden(room);
  const visible = room.messages.filter((m) => !hidden.messages.has(m.seq));
  atomicReadonly(join(root, "timeline.md"), `# ${room.title}\n群聊 ${room.roomId}；截止 #${room.messages.at(-1)?.seq ?? 0}${hidden.messages.size ? `\n独立作答中：有 ${hidden.messages.size} 条回复在这一轮所有成员答完后放出` : ""}\n\n${visible.map((m) => `## #${m.seq} ${m.author}${sourceLabel(m.source, anonymous)}\n${m.replyTo ? `回应 #${m.replyTo}\n` : ""}${m.quotes.length ? `引用：${m.quotes.map((q) => `#${q.seq}${q.span ? `[${q.span.start}:${q.span.end})` : ""}`).join("、")}\n` : ""}${m.text}`).join("\n\n")}`);
  for (const member of room.members) {
    const hideTurns = hidden.turns.get(member.memberId);
    const events = mgr.store.events(member.platformSessionId).filter((e) => !(hideTurns && e.turnNo !== undefined && hideTurns.has(e.turnNo)));
    const native = mgr.store.binding(member.platformSessionId)?.nativeSessionId;
    const clean = (text: string) => native ? text.split(native).join("[原生会话 ID 已隐藏]") : text;
    const process = events.filter((e) => e.kind !== "message" || e.role === "assistant").flatMap((e) => {
      if (e.kind === "message" && e.role === "assistant") return [`## seq ${e.seq} 回复 · 轮次 ${e.turnNo ?? "未知"}\n${clean(e.text ?? "")}`];
      if (room.settings.shareScope === "replies") return [];
      if (e.tool) return [`## seq ${e.seq} 工具 ${e.tool.name} · ${e.tool.status ?? "未知"}\n输入摘要：${clean(bounded(e.tool.input, 1000).text)}${room.settings.shareScope === "full" ? `\n输出：${clean(e.tool.output ?? "")}` : ""}`];
      if (room.settings.shareScope === "full" && e.text && e.kind !== "approval") return [`## seq ${e.seq} ${e.kind}\n${clean(e.text)}`];
      return [];
    });
    atomicReadonly(join(root, "members", `${member.alias}.md`), `# @${member.alias}\n平台会话：${member.platformSessionId}${anonymous ? "" : `\n运行时：${member.binding.runtimeKind}/${member.binding.model ?? "默认"}`}\n截止 seq ${events.at(-1)?.seq ?? 0}\n\n${process.join("\n\n")}`);
  }
  // 可写成员在自己的 worktree 里工作：各写一份同样的快照，成员只需读自己工作目录下的 .pi-room/
  for (const m of room.members) {
    if (!m.worktree || m.removedAt || !existsSync(m.worktree.workspace)) continue;
    checkSnapshotPath(m.worktree.workspace, room.roomId, true);
    const copy = join(m.worktree.workspace, ".pi-room", room.roomId);
    mkdirSync(join(copy, "members"), { recursive: true });
    for (const rel of [".room-owner", "timeline.md", ...room.members.map((x) => join("members", `${x.alias}.md`))]) {
      if (existsSync(join(root, rel))) atomicReadonly(join(copy, rel), readFileSync(join(root, rel), "utf8"));
    }
  }
}

export function deleteRoomSnapshot(room: Room): void {
  const root = roomSnapshotRoot(room); if (!existsSync(root)) return;
  checkSnapshotPath(room.workspace, room.roomId, true); rmSync(root, { recursive: true, force: true });
}
