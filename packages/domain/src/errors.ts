/**
 * 错误模型（AP-SCHEMA-002 §5 / AP-COMP-003 §2）。
 * 平台错误全部携带机器可判定 code 与字段路径。
 */
export type PlatformErrorCode =
  // 编译错误
  | "SCHEMA_INVALID"
  | "REF_NOT_FOUND"
  | "CIRCULAR_REF"
  | "POLICY_EMPTY_SET"
  | "RUNTIME_UNSUPPORTED"
  | "NON_DETERMINISTIC"
  | "SIGNING_UNAVAILABLE"
  | "CONSTRAINT_UNKNOWN"
  | "VALIDATION_SEMANTIC"
  // 状态机与命令错误（AP-STATE-007）
  | "STATE_INVALID_TRANSITION"
  | "GUARD_FAILED"
  | "VERSION_CONFLICT"
  | "COMMAND_DUPLICATE"
  | "COMMAND_ID_REUSED"
  | "EVIDENCE_MISSING"
  | "ARTIFACT_MISSING"
  | "ACCEPTANCE_REVISION_MISMATCH"
  // 命令权限（评审第二轮 R2-A）
  | "COMMAND_UNAUTHORIZED"
  // 策略错误（AP-POLICY-004）
  | "POLICY_FAIL_CLOSED"
  | "APPROVAL_INVALID"
  | "BUDGET_EXHAUSTED";

export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly path?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: PlatformErrorCode, message: string, options?: { path?: string; details?: Record<string, unknown> }) {
    super(`[${code}] ${message}`);
    this.name = "PlatformError";
    this.code = code;
    this.path = options?.path;
    this.details = options?.details;
  }
}

export function isPlatformError(e: unknown): e is PlatformError {
  return e instanceof PlatformError;
}
