import { gramsOf } from './topics.js';
import type { RepetitionMessage, SessionDigest } from './types.js';

/** 只检索可能相关的用户原话。相似度不决定是否准入，同对象、同原则由提炼模型判断，来源由代码核验。 */
export class RepetitionIndex {
  private readonly messages: Array<RepetitionMessage & { grams: Set<string> }> = [];
  private readonly postings = new Map<string, number[]>();

  constructor(sessions: readonly SessionDigest[]) {
    for (const s of sessions) for (const m of s.messages) {
      if (m.text.trim().length < 6) continue;
      const text = m.text.slice(0, 800), grams = gramsOf(text), index = this.messages.length;
      this.messages.push({ sessionId: s.sessionId, project: s.project, at: m.at, text, grams });
      for (const gram of grams) {
        const list = this.postings.get(gram) ?? [];
        list.push(index); this.postings.set(gram, list);
      }
    }
  }

  forSession(session: SessionDigest): RepetitionMessage[] {
    const scores = new Map<number, number>();
    let inputSize = 0;
    for (const m of session.messages) {
      const text = m.text.slice(0, 800); inputSize += text.length;
      if (inputSize > 12_000) break;
      const grams = gramsOf(text), shared = new Map<number, number>();
      for (const gram of grams) for (const index of this.postings.get(gram) ?? []) shared.set(index, (shared.get(index) ?? 0) + 1);
      for (const [index, count] of shared) scores.set(index, Math.max(scores.get(index) ?? 0, count / Math.sqrt(grams.size * this.messages[index]!.grams.size)));
    }
    const ranked = [...scores].map(([index, score]) => ({ message: this.messages[index]!, score }))
      .filter(x => x.message.sessionId !== session.sessionId && x.score >= 0.15)
      .sort((a, b) => b.score - a.score || b.message.at.localeCompare(a.message.at));
    const out: RepetitionMessage[] = []; let size = 0;
    for (const { message } of ranked) {
      if (out.length >= 12 || size + message.text.length > 6_000) break;
      const { grams: _, ...source } = message;
      out.push(source); size += message.text.length;
    }
    return out;
  }
}
