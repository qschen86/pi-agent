import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelInvocationPort } from '../../../packages/model-port/src/index.js';
import { prepareImages } from '../../../packages/model-port/src/index.js';
import type { RuntimeDriver } from '../../../packages/runtime-sessions/src/driver.js';

// Auxiliary jobs use the selected subscription, a fresh native conversation and an empty
// private directory. They cannot approve tool requests or inherit a user's conversation.
export function nativeModelPort(root: string, driver: RuntimeDriver, model: () => string | undefined): ModelInvocationPort {
  return { async complete(config, call) {
    const started = Date.now(); const messages = new Map<string, string>(); let effectiveModel: string | undefined;
    prepareImages(config, call.images, call.imageLimits);
    const workspace = join(root, 'runtime/completions', randomUUID()); mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const handle = await driver.startTurn({ workspace, model: model(), clientMessageId: randomUUID(), prompt: call.prompt,
      roleInstructions: `${call.system}\n只输出答案。不要调用工具、读取文件或访问网络。`,
      images: call.images?.map(image => ({ mimeType: image.mediaType, data: Buffer.from(image.bytes).toString('base64'), sha256: createHash('sha256').update(image.bytes).digest('hex') })), readOnlyRoom: true, permissionMode: driver.kind === 'codex' ? 'read-only' : 'plan'
    }, { nativeSession(_id, info) { effectiveModel = info.effectiveModel; }, nativeTurn() {}, usage() {}, rateLimit() {}, status() {},
      event(event) { if (event.kind === 'message' && event.role === 'assistant' && event.text) messages.set(event.key, event.text); },
      async approval() { return { approve: false, reason: '内部文本补全不允许工具操作' }; }
    });
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => { void handle.interrupt().catch(() => {}); reject(Error('所选账号的内部文本调用超时')); }, config.timeoutMs); timeout.unref();
    });
    try {
      const result = await Promise.race([handle.done, deadline]);
      const text = [...messages.values()].join('\n');
      if (result.status !== 'completed' || result.terminalObserved !== true || !text) throw Error('所选账号的内部文本调用未完成');
      return { text, durationMs: Date.now() - started, ...(effectiveModel ? { model: effectiveModel } : {}), stopReason: 'stop' };
    } finally { clearTimeout(timeout!); rmSync(workspace, { recursive: true, force: true }); }
  } };
}
