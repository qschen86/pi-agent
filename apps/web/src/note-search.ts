/**
 * 待办记录搜索（只读）：把关键词拆成若干词，每个词都要出现在记录的某个可搜索字段里（AND），
 * 忽略大小写与全/半角差异。不改动记录，只决定「哪些记录命中」。
 *
 * 可搜索字段：正文、分类（一级 / 二级）、图片文件名、关联会话标题。
 * 前端 apps/web/public/notes.js 里有一份等价实现用于本地即时筛选与高亮，改规则时两处一起改。
 */
import type { Note } from "./notes.js";

/** 查询串最长保留的字符数：再长的查询没有意义，也避免被当成放大器。 */
export const NOTE_SEARCH_MAX_LENGTH = 200;
/** 最多使用的关键词个数 */
export const NOTE_SEARCH_MAX_TERMS = 8;

/** 归一：NFKC（全角转半角）+ 小写。 */
export function normalizeNoteSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

/** 把用户输入拆成去重后的关键词；空白（含全角空格、逗号）分隔。 */
export function parseNoteSearchQuery(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  const terms = normalizeNoteSearchText(raw.slice(0, NOTE_SEARCH_MAX_LENGTH)).split(/[\s,，、]+/).filter(Boolean);
  return [...new Set(terms)].slice(0, NOTE_SEARCH_MAX_TERMS);
}

interface ClassificationRow { primary?: unknown; secondary?: unknown }

function categoryNames(note: Note): string[] {
  const c = (note as { classification?: { categories?: ClassificationRow[]; primary?: unknown; secondary?: unknown } }).classification;
  if (!c) return [];
  const rows: ClassificationRow[] = Array.isArray(c.categories) && c.categories.length ? c.categories : [c];
  return rows.flatMap((r) => [r.primary, r.secondary]).filter((v): v is string => typeof v === "string" && !!v);
}

/** 一条记录里所有可搜索的文字（已归一，字段之间用换行隔开，避免词跨字段拼接命中）。 */
export function noteSearchHaystack(note: Note, sessionTitles: readonly string[] = []): string {
  const parts = [note.text, ...categoryNames(note), ...(note.images ?? []).map((i) => i.name), ...sessionTitles];
  return normalizeNoteSearchText(parts.join("\n"));
}

export function noteMatchesSearch(note: Note, terms: readonly string[], sessionTitles: readonly string[] = []): boolean {
  if (!terms.length) return true;
  const haystack = noteSearchHaystack(note, sessionTitles);
  return terms.every((t) => haystack.includes(t));
}
