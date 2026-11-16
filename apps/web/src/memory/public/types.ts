/**
 * 平台公共记忆的设置与错误类型。条目本身（个人偏好 / 项目记忆）的数据模型在 pipeline/types.ts。
 * 旧机制（runtime 私有记忆扫描 → 候选 → 人审 → knowledge/disputes）已下线，这里不再有它的类型。
 */
/**
 * injectEnabled：新会话首轮是否自动注入公共记忆，默认关。
 * pipelineEnabled：每日定时从平台会话里提炼公共记忆，默认关；手动触发与「记住…」即时提炼不受它限制。
 */
export interface PublicSettings { injectEnabled: boolean; pipelineEnabled: boolean }
export const defaultSettings = (): PublicSettings => ({ injectEnabled: false, pipelineEnabled: false });

export interface PublicData { settings: PublicSettings }

export type PublicErrorCode = 'invalid-input' | 'not-found' | 'conflict' | 'busy' | 'disabled' | 'storage-error';
export class PublicMemoryError extends Error {
  constructor(readonly code: PublicErrorCode, message?: string) { super(message ?? code); }
}
