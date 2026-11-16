/**
 * 会话 → 待办 关联回填的匹配规则（启动对账与一次性修复脚本共用）。
 *
 * 从待办发起的会话首条消息里留着引用块：
 *   引用待办记录（记于 2026-10-19 09:35）：
 *
 *   > 確認過了之後，這個已確認要消失的
 * 历史上这种会话可能丢了 noteRef（引用 chip 被删掉时整条关联被清空），这里按「记于」时间 + 首行文字反查待办：
 * 首行唯一命中就用它；同首行有多条时再用「记于」时间挑；仍不唯一就返回 null（不猜）。
 */
import { beijingStamp } from "./platform-time.js";

/** 引用块里的「记于 2026-10-19 09:35」：与待办页 noteStamp 同格式（北京时间，分钟精度） */
export function noteStampLocal(iso: string): string {
  return beijingStamp(iso);
}

export type NoteRefQuery = { stamp: string; line: string };

/** 待办库 → 反查函数：喂给 RuntimeSessionManager.backfillNoteRefs / backfillSessionNoteRefs */
export function noteRefLookup(notes: ReadonlyArray<{ id: string; text?: string | null; createdAt: string }>): (query: NoteRefQuery) => string | null {
  const key = (value: string) => String(value || "").trim().replace(/\s+/g, " ");
  const byLine = new Map<string, { id: string; stamp: string }[]>();
  for (const note of notes) {
    const line = key((note.text || "").split("\n").find((l) => l.trim()) ?? "");
    // 只有图片的待办没有可比的正文，不参与反查
    if (!line) continue;
    const rows = byLine.get(line) ?? [];
    rows.push({ id: note.id, stamp: noteStampLocal(note.createdAt) });
    byLine.set(line, rows);
  }
  return ({ stamp, line }) => {
    const rows = byLine.get(key(line)) ?? [];
    if (rows.length === 1) return rows[0]!.id;
    const same = rows.filter((r) => r.stamp && r.stamp === stamp);
    return same.length === 1 ? same[0]!.id : null;
  };
}
