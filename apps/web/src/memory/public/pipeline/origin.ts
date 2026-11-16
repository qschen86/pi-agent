import { readFileSync } from 'node:fs';

/**
 * 谁发的这条消息：只有人亲手发的才算“用户消息”，才能进记忆（实时 / 定时都一样）；
 * 平台自动发的（部署通知、额度续聊、冲突自动解决、评测 harness、宿主）和模型的回复都不主动接入，最多作为理解上下文用。
 *
 * 依据是账本审计里每次「发送 / 创建」记的 actor：人是 `local`、登录设备 `ls-…`、公网 `public`；
 * 平台自动发送者约定用 `system:` 前缀（如 `system:quota-resume`），早期的几个没有前缀，列在 NON_HUMAN_ACTORS 里。
 * 用“排除已知非人”而不是“只认已知人”：人的 actor 形态多（本机 / 登录设备 / 公网），白名单会误伤真人。
 * 新增自动发送者请用 `system:` 前缀。
 */
export const NON_HUMAN_ACTORS: ReadonlySet<string> = new Set(['deploy-auto-resolve', 'harness', 'host']);
export type Origin = 'human' | 'system' | 'unknown';
export const originOfActor = (actor: string | null | undefined): Origin =>
  !actor ? 'unknown' : actor.startsWith('system:') || NON_HUMAN_ACTORS.has(actor) ? 'system' : 'human';

/** operationId → actor（只含「发送 / 创建」）。文件不存在 / 读不到返回空表；调用方对查不到的按“未知”处理，不丢消息。 */
export function readActorIndex(auditFile: string): Map<string, string> {
  const out = new Map<string, string>();
  let text: string;
  try { text = readFileSync(auditFile, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.includes('"operationId"') || !(line.includes('"type":"turn"') || line.includes('"type":"create"'))) continue;
    try {
      const d = JSON.parse(line) as { type?: string; operationId?: string; actor?: unknown };
      if ((d.type === 'turn' || d.type === 'create') && d.operationId && typeof d.actor === 'string') out.set(d.operationId, d.actor);
    } catch { /* 半行 */ }
  }
  return out;
}
