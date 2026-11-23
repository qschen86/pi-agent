/**
 * 诊断待办的读写（V1.4 §7.1）：只在 Web 进程里经 ConsoleService 写，notes.json 始终只有一个写者。
 * - 大类直接定为待办（kindSource=user），不让 AI 改成笔记
 * - 分类钉死在待办目录的「平台 / debug」，路径不存在时创建（钉住 = 模型分类和策略升级都不覆盖）
 * - 人工开发判定 + 不进整理器合并池（NoteIterations.markDiagnostic / setDirectSingles）
 */
import type { ConsoleService } from "../console.js";
import type { DiagnosticNotes, NoteAnalysis } from "./triage.js";

export function debugCategoryId(svc: ConsoleService): string | null {
  const cats = svc.noteCategories.snapshot().categories;
  const platform = cats.find((c) => !c.parentId && !c.scope && c.name === "平台");
  const debug = platform && cats.find((c) => c.parentId === platform.id && c.name.toLowerCase() === "debug");
  return debug?.id ?? null;
}

function assignDebug(svc: ConsoleService, noteId: string): void {
  const id = debugCategoryId(svc) ?? svc.noteCategories.create({
    primary: "平台", secondary: "debug", scope: "todo", version: svc.noteCategories.snapshot().version
  }).createdCategoryId;
  // 钉住：正文改写、分类策略升级、模型重分类都不会把它改成别的标签（人手动改分类才解除）。
  svc.noteCategories.pin(noteId, id);
}

/** 只接收持久层记录的来源 ID；不通过标题、正文或相似度认领。重复执行不重复写入。 */
export function backfillDebugCategories(svc: ConsoleService, noteIds: Iterable<string>, onWarning: (message: string) => void = () => {}) {
  const result = { assigned: 0, unchanged: 0, missing: 0, skipped: 0, failed: 0 };
  const existing = new Map(svc.listNotes().map(n => [n.id, n]));
  for (const id of new Set(noteIds)) {
    const note = existing.get(id);
    if (!note) { result.missing++; continue; }
    if (note.kind !== "todo" || note.schedule) { result.skipped++; continue; }
    try {
      const before = svc.getNote(id) as { classification?: { categoryIds?: string[]; source?: string; state?: string } };
      const debug = debugCategoryId(svc);
      const current = before.classification;
      const unchanged = current?.source === "manual" && current.state === "classified" && current.categoryIds?.length === 1 && current.categoryIds[0] === debug;
      assignDebug(svc, id);
      if (unchanged) result.unchanged++; else result.assigned++;
    } catch (e) { result.failed++; onWarning(`错误统计待办 ${id} 补归类失败：${(e as Error).message}`); }
  }
  return result;
}

export function diagnosticNotes(svc: ConsoleService, onWarning: (message: string) => void = () => {}): DiagnosticNotes {
  const classify = (noteId: string) => {
    try { assignDebug(svc, noteId); }
    catch (e) { onWarning(`诊断待办归类失败：${(e as Error).message}`); }
  };
  return {
    create(text: string, analysis: NoteAnalysis): string {
      // 诊断正文由模型生成，不排「整理」：改写正文会让分类哈希失效，AI 重新分类会冲掉下面的「平台 / debug」。
      const note = svc.addNote(text, undefined, undefined, { kind: "todo", skipWriting: true });
      classify(note.id);
      svc.noteIterations.markDiagnostic(note.id, analysis);
      return note.id;
    },
    rewrite(noteId: string, text: string, analysis: NoteAnalysis): void {
      try {
        svc.updateNote(noteId, { text }, { skipWriting: true });
        classify(noteId);
        svc.noteIterations.markDiagnostic(noteId, analysis);
      } catch (e) { onWarning(`更新诊断待办失败：${(e as Error).message}`); }
    },
    find(marker: string, since: string): string | null {
      const hit = svc.listNotes().find((n) => n.createdAt >= since && n.text.includes(marker));
      return hit?.id ?? null;
    },
    state(noteId: string): "open" | "done" | "deleted" {
      try { return svc.getNote(noteId).done ? "done" : "open"; } catch { return "deleted"; }
    }
  };
}

/** 每晚错误统计的待办：创建 / 改写 / 状态沿用诊断待办的写法（平台 / debug、人工开发判定），再多一个读正文（判断人有没有改过）。 */
export function errorStatsNotes(svc: ConsoleService, onWarning: (message: string) => void = () => {}) {
  const base = diagnosticNotes(svc, onWarning);
  return {
    create: base.create, rewrite: base.rewrite, state: base.state,
    backfillCategories: (noteIds: Iterable<string>) => backfillDebugCategories(svc, noteIds, onWarning),
    text(noteId: string): string | null { try { return svc.getNote(noteId).text; } catch { return null; } }
  };
}
