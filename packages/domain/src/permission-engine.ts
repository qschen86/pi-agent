/**
 * Permission Engine（09 计划 §6 模块 3 / AP-SCHEMA-002 §2 / AP-COMP-003 §3）。
 *
 * effective_permission =
 *   agent.capabilities ∩ task.authorization ∩ organization.policy
 *   ∩ runtime.capability ∩ infrastructure.boundary
 *
 * 合并规则（restrictive-wins，优先级 infrastructure > organization > task > agent > runtime-default）：
 * - 授权集合（文件读写、网络域名、工具白名单）：五层取交集；空集 → POLICY_EMPTY_SET
 * - 禁止项：并集，deny 优先且不可覆盖
 * - 预算：各声明层取最小值
 * - 审批：取更严格级别（AUTO < REVIEW < DUAL）
 * 不变量 INV-02：任何一层不得放大上层授权——结果必须是每一层的子集。
 */
import { PlatformError } from "./errors.js";

export type ApprovalLevel = "AUTO" | "REVIEW" | "DUAL";
const APPROVAL_STRICTNESS: Record<ApprovalLevel, number> = { AUTO: 0, REVIEW: 1, DUAL: 2 };

export interface PathScope {
  read: string[];
  write: string[];
}

export interface NetworkScope {
  default: "deny" | "allow";
  allow: string[];
}

export interface BudgetLimits {
  tokens?: number;
  wallTimeMs?: number;
  toolCalls?: number;
}

export interface PermissionLayer {
  /** 层名，用于错误信息与审计 */
  name: string;
  filesystem?: PathScope;
  network?: NetworkScope;
  tools?: { allow: string[]; deny?: string[] };
  /**
   * 受控命令执行：允许的可执行文件（argv[0] 的基名）。
   * **未声明 = 该层不授予任何命令执行**——与 filesystem 不同，
   * 这里的"缺失"必须是禁止，不能是"不限制"。
   */
  commands?: { allow: string[] };
  /** Capability grants are exact IDs; a missing layer grants nothing. */
  capabilities?: { connections: string[]; operations: string[]; resources: string[]; deny?: string[] };
  /**
   * 联网检索的来源范围（v1.8）：允许阅读哪些网页域名，"*" 为开放来源。
   * 与 commands 同口径：**未声明 = 该层不授予**。
   */
  webResearch?: { sourceDomains: string[] };
  budget?: BudgetLimits;
  approvals?: { sideEffects: ApprovalLevel };
  /** 本层追加的禁止项（并集；deny 优先） */
  deny?: Array<{ resource: "filesystem" | "network" | "command" | "credential" | "tool" | "budget"; pattern: string; reason?: string }>;
}

export interface EffectivePermissions {
  filesystem: PathScope & { maxWriteBytes?: number };
  network: NetworkScope;
  tools: { allow: string[] };
  /** 逐层取交集后的可执行文件白名单；空 = 完全不可执行命令 */
  commands: { allow: string[] };
  /** 逐层取交集后的来源域名；空 = 不可阅读任何网页 */
  webResearch: { sourceDomains: string[] };
  budget: Required<BudgetLimits>;
  approvals: { sideEffects: ApprovalLevel };
  deny: NonNullable<PermissionLayer["deny"]>;
}

const ORDER_NETWORK = ["deny", "allow"] as const;

/** POSIX 规范路径：绝对、NFC、去尾斜杠、解析 . 与 ..；容器外路径拒绝。 */
export function normalizePath(p: string): string {
  if (!p.startsWith("/")) {
    throw new PlatformError("CONSTRAINT_UNKNOWN", `路径必须是绝对路径：${p}`, { path: p });
  }
  if (p.includes("\0")) {
    throw new PlatformError("CONSTRAINT_UNKNOWN", "路径包含空字节", { path: p });
  }
  const nfc = p.normalize("NFC");
  const segs: string[] = [];
  for (const seg of nfc.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segs.length === 0) {
        throw new PlatformError("CONSTRAINT_UNKNOWN", `路径逃逸（.. 越过根）：${p}`, { path: p });
      }
      segs.pop();
      continue;
    }
    segs.push(seg);
  }
  return "/" + segs.join("/");
}

function normalizeScope(scope: PathScope, _layer: string): PathScope {
  return {
    read: scope.read.map((p) => normalizePath(p)),
    // 说明：单层的宽授权（如 runtime-default 的 /）不构成风险——
    // 五层取交集后结果不可能宽于任何一层（INV-02），Gateway 只消费交集结果。
    write: scope.write.map((p) => normalizePath(p))
  };
}

function intersectPaths(layers: Array<{ name: string; scope: PathScope }>, kind: "read" | "write"): string[] {
  // 路径是层级前缀作用域：交集 = 候选必须落在每一层的某个前缀内。
  // 两层 {A} ∩ {B}：A⊆B 取 A；B⊆A 取 B；不相交的配对不贡献区域。
  let acc: string[] | null = null;
  for (const l of layers) {
    const next = l.scope[kind];
    acc = acc === null ? next : intersectPrefixRegions(acc, next);
  }
  return dedupe(acc ?? []);
}

function isPrefixOf(prefix: string, candidate: string): boolean {
  if (candidate === prefix) return true;
  return candidate.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
}

function intersectPrefixRegions(acc: string[], next: string[]): string[] {
  const out: string[] = [];
  for (const a of acc) {
    for (const b of next) {
      if (isPrefixOf(b, a)) out.push(a);
      else if (isPrefixOf(a, b)) out.push(b);
    }
  }
  return out;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

/** 域名 d 是否在范围 p 之内（相同或是其子域名）。 */
export function domainCovers(p: string, d: string): boolean {
  return p === "*" || d === p || d.endsWith(`.${p}`);
}

/** 来源域名逐层求交：结果只会更窄，排序后确定（同一批授权产生同一个 planHash）。 */
export function intersectDomains(layers: string[][]): string[] {
  let acc: string[] | null = null;
  for (const raw of layers) {
    const set = raw.map((d) => d.trim().toLowerCase()).filter(Boolean);
    if (acc === null) { acc = set; continue; }
    const out = new Set<string>();
    for (const a of acc) {
      for (const b of set) {
        if (domainCovers(a, b)) out.add(b);
        else if (domainCovers(b, a)) out.add(a);
      }
    }
    acc = [...out];
  }
  // 去掉被更宽条目覆盖的冗余项（"*" 与具体域名并存时只留 "*"）
  const result = acc ?? [];
  return [...new Set(result.filter((d) => !result.some((o) => o !== d && domainCovers(o, d))))].sort();
}

function intersectAllow(layers: string[][]): string[] {
  let acc: string[] | null = null;
  for (const set of layers) {
    const s = new Set(set);
    acc = acc === null ? set : acc.filter((v) => s.has(v));
  }
  return acc ?? [];
}

function minBudget(layers: Array<{ name: string; budget: BudgetLimits }>): Required<BudgetLimits> {
  const declared = {
    tokens: layers.map((l) => l.budget.tokens).filter((v): v is number => typeof v === "number"),
    wallTimeMs: layers.map((l) => l.budget.wallTimeMs).filter((v): v is number => typeof v === "number"),
    toolCalls: layers.map((l) => l.budget.toolCalls).filter((v): v is number => typeof v === "number")
  };
  const pick = (xs: number[], fallback: number): number => (xs.length === 0 ? fallback : Math.min(...xs));
  return {
    tokens: pick(declared.tokens, Number.MAX_SAFE_INTEGER),
    wallTimeMs: pick(declared.wallTimeMs, Number.MAX_SAFE_INTEGER),
    toolCalls: pick(declared.toolCalls, Number.MAX_SAFE_INTEGER)
  };
}

function strictestApproval(layers: Array<{ name: string; level: ApprovalLevel }>): ApprovalLevel {
  return layers.reduce<ApprovalLevel>(
    (acc, l) => (APPROVAL_STRICTNESS[l.level] > APPROVAL_STRICTNESS[acc] ? l.level : acc),
    "AUTO"
  );
}

function networkDefaultOf(layers: Array<{ name: string; scope: NetworkScope }>): "deny" | "allow" {
  // restrictive-wins：任何一层 default=deny，则整体 deny。
  return layers.some((l) => l.scope.default === "deny") ? "deny" : "allow";
}

function emptyIntersectionError(kind: string, layers: Array<{ name: string; items: string[] }>): PlatformError {
  return new PlatformError(
    "POLICY_EMPTY_SET",
    `${kind} 权限交集为空（层：${layers.map((l) => `${l.name}[${l.items.length}]`).join(", ")}）；请修改 Contract 授权`,
    { details: { kind } }
  );
}

/**
 * 五层权限交集。抛出 POLICY_EMPTY_SET（授权交集为空）或 CONSTRAINT_UNKNOWN（路径非法）。
 */
export function mergePermissions(layers: PermissionLayer[]): EffectivePermissions {
  if (layers.length === 0) {
    throw new PlatformError("POLICY_EMPTY_SET", "未提供任何权限层");
  }

  const fsLayers = layers
    .filter((l) => l.filesystem !== undefined)
    .map((l) => ({ name: l.name, scope: normalizeScope(l.filesystem as PathScope, l.name) }));
  if (fsLayers.length !== layers.length) {
    throw new PlatformError("POLICY_EMPTY_SET", "五层均必须声明 filesystem 授权（缺失视为空集）");
  }

  const read = intersectPaths(fsLayers, "read");
  const write = intersectPaths(fsLayers, "write");
  if (read.length === 0) throw emptyIntersectionError("filesystem.read", fsLayers.map((l) => ({ name: l.name, items: l.scope.read })));
  if (write.length === 0) throw emptyIntersectionError("filesystem.write", fsLayers.map((l) => ({ name: l.name, items: l.scope.write })));

  const netLayers = layers.map((l) => {
    if (l.network === undefined) {
      throw new PlatformError("POLICY_EMPTY_SET", `层 ${l.name} 未声明 network 授权`);
    }
    if (!ORDER_NETWORK.includes(l.network.default)) {
      throw new PlatformError("CONSTRAINT_UNKNOWN", `层 ${l.name} 的 network.default 非法`);
    }
    return { name: l.name, scope: l.network };
  });
  const denyNet = networkDefaultOf(netLayers);
  const netAllow = intersectAllow(netLayers.map((l) => l.scope.allow));
  if (denyNet === "deny" && netAllow.length === 0) {
    // 默认拒绝且白名单交集为空：网络完全关闭。这是合法且常见的强约束形态，
    // 与文件授权不同（文件必须有可读/可写路径），此处不报错。
  }

  const toolLayers = layers.map((l) => {
    if (l.tools === undefined) {
      throw new PlatformError("POLICY_EMPTY_SET", `层 ${l.name} 未声明 tools 白名单`);
    }
    return { name: l.name, allow: l.tools.allow, deny: l.tools.deny ?? [] };
  });
  const toolAllow = intersectAllow(toolLayers.map((l) => l.allow));
  if (toolAllow.length === 0) {
    throw emptyIntersectionError("tools.allow", toolLayers.map((l) => ({ name: l.name, items: l.allow })));
  }
  const denyToolSet = new Set(toolLayers.flatMap((l) => l.deny));
  const effectiveTools = toolAllow.filter((t) => !denyToolSet.has(t));
  if (effectiveTools.length === 0) {
    throw emptyIntersectionError("tools.allow(after deny)", toolLayers.map((l) => ({ name: l.name, items: l.allow })));
  }

  // 受控命令执行：任一层未声明即视为不授予，交集自然为空（fail closed）。
  // 因此现存的、没声明 commands 的配置行为完全不变：命令执行仍然不可用。
  // 排序：安全相关的白名单必须规范化——同一批授权无论各层声明顺序如何，
  // 都产生逐字节相同的策略与 planHash。
  const commandAllow = [...intersectAllow(layers.map((l) => l.commands?.allow ?? []))].sort();

  // 来源域名（v1.8）：任一层未声明即为空；"*" 与具体域名求交取具体域名，父域覆盖子域取更窄的那个
  const sourceDomains = intersectDomains(layers.map((l) => l.webResearch?.sourceDomains ?? []));

  const denyUnion = layers.flatMap((l) => l.deny ?? []);

  return {
    filesystem: { read, write },
    network: { default: denyNet, allow: netAllow },
    tools: { allow: effectiveTools },
    commands: { allow: commandAllow },
    webResearch: { sourceDomains },
    budget: minBudget(layers.filter((l) => l.budget !== undefined).map((l) => ({ name: l.name, budget: l.budget as BudgetLimits }))),
    approvals: { sideEffects: strictestApproval(layers.filter((l) => l.approvals !== undefined).map((l) => ({ name: l.name, level: (l.approvals as { sideEffects: ApprovalLevel }).sideEffects }))) },
    deny: denyUnion
  };
}

/** 路径包含判定（用于 Gateway 与测试）：candidate 必须在 prefix 之内。 */
export function pathWithin(candidate: string, prefix: string): boolean {
  const c = normalizePath(candidate);
  const p = normalizePath(prefix);
  if (c === p) return true;
  return c.startsWith(p.endsWith("/") ? p : p + "/");
}

/** External capability scope: exact set intersections and deny wins, independent of filesystem grants. */
export function mergeCapabilityPermissions(layers: PermissionLayer[]) {
 const scopes=layers.map(l=>l.capabilities);
 const deny=new Set(scopes.flatMap(s=>s?.deny??[]));
 const intersect=(key: "connections"|"operations"|"resources")=>intersectAllow(scopes.map(s=>s?.[key]??[])).filter(x=>!deny.has(x)).sort();
 return {connections:intersect("connections"),operations:intersect("operations"),resources:intersect("resources"),approval:strictestApproval(layers.map(l=>({name:l.name,level:l.approvals?.sideEffects??"AUTO"}))) };
}
