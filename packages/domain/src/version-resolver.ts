/**
 * Version Resolver（09 计划 §6 模块 2 / ADR-0103 引用必须精确 pin）。
 * - 精确 pin：引用版本必须存在于 registry snapshot，否则 REF_NOT_FOUND，禁止编译。
 * - 循环检测：workflow 依赖图 DFS 检测环，CIRCULAR_REF。
 */
import { PlatformError } from "./errors.js";

export interface RegistryObject {
  key: string; // 形如 "workflowId@1.2.3" 或 "agent@1.0.0"
  version: string;
  body: unknown;
}

export interface RegistrySnapshot {
  snapshotId: string;
  objects: RegistryObject[];
}

export interface PinRequest {
  /** 形如 "report.publish@2.1.0"；编译期必须精确 pin */
  ref: string;
  /** 引用类型，仅用于错误信息 */
  kind?: string;
}

export interface ResolvedPin {
  ref: string;
  key: string;
  body: unknown;
}

function assertExactRef(ref: string): { name: string; version: string } {
  const idx = ref.lastIndexOf("@");
  if (idx <= 0 || idx === ref.length - 1) {
    throw new PlatformError("REF_NOT_FOUND", `引用必须是精确 pin（name@version）：${ref}`, { path: ref });
  }
  return { name: ref.slice(0, idx), version: ref.slice(idx + 1) };
}

/**
 * 解析单条精确引用。snapshot 中不存在即失败（REF_NOT_FOUND），不猜测、不回退。
 */
export function resolveRef(snapshot: RegistrySnapshot, req: PinRequest): ResolvedPin {
  const { name, version } = assertExactRef(req.ref);
  const key = `${name}@${version}`;
  const found = snapshot.objects.find((o) => o.key === key);
  if (!found) {
    throw new PlatformError(
      "REF_NOT_FOUND",
      `${req.kind ?? "引用"} ${req.ref} 在 registry snapshot ${snapshot.snapshotId} 中不存在`,
      { path: req.ref }
    );
  }
  return { ref: req.ref, key, body: found.body };
}

export interface WorkflowRefNode {
  key: string; // 已解析对象的键 "wf@1.0.0"
  requires: string[]; // 该 workflow 声明的依赖 ref（精确 pin）
}

/**
 * 依赖环检测：以已解析对象的 requires 边构建图，DFS 三色标记。
 * entry 是入口键；凡可达路径中出现环即抛 CIRCULAR_REF，并给出环路径。
 */
export function assertNoCircularDeps(
  nodes: Map<string, WorkflowRefNode>,
  entry: string,
  resolveRefByName: (ref: string) => string
): void {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (key: string): void => {
    const c = color.get(key) ?? WHITE;
    if (c === GRAY) {
      const cycleStart = stack.indexOf(key);
      const cycle = stack.slice(cycleStart === -1 ? 0 : cycleStart).concat(key);
      throw new PlatformError("CIRCULAR_REF", `检测到循环引用：${cycle.join(" → ")}`, { path: key });
    }
    if (c === BLACK) return;
    color.set(key, GRAY);
    stack.push(key);
    const node = nodes.get(key);
    for (const dep of node?.requires ?? []) {
      visit(resolveRefByName(dep));
    }
    stack.pop();
    color.set(key, BLACK);
  };

  visit(entry);
}
