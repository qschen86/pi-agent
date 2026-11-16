/**
 * 事件日志端口（AP-PLAN-009 §6 模块 8：仓储端口「可替换数据库」）。
 *
 * 领域定义端口，基础设施实现它：内存、PostgreSQL、未来的托管数据库都必须
 * 通过同一套消费者驱动契约（packages/persistence/test/journal-contract.test.ts）。
 *
 * 三条不可退让的语义：
 *   - **无丢失**：append 返回即可读回。
 *   - **无半提交**：批次内任一事件冲突，整批都不落库。
 *   - **幂等**：重复 event_id 与重复 (stream, aggregate_version) 都不产生第二条记录。
 */
import type { EventEnvelope } from "./task-session.js";

export interface StoredEvent extends EventEnvelope {
  streamId: string;
  globalSequence: number;
}

export interface AppendResult {
  appended: StoredEvent[];
  /** 因 event_id 或 (stream, version) 重复而被忽略的事件数 */
  duplicates: number;
}

export interface EventJournal {
  append(streamId: string, events: EventEnvelope[]): Promise<AppendResult>;
  readStream(streamId: string, fromVersion?: number): Promise<StoredEvent[]>;
  currentVersion(streamId: string): Promise<number>;
  /**
   * 租约取出未确认事件。持有未过期租约的 worker 之外的调用方拿不到；
   * 租约过期即可被接手——崩溃的 worker 不会把消息永久吞掉。
   */
  leaseOutbox(workerId: string, nowMs: number, ttlMs?: number): Promise<StoredEvent[]>;
  ackOutbox(eventIds: string[]): Promise<void>;
  /** 消费侧幂等（inbox）查询：该消费者是否已经处理过该事件。 */
  hasConsumed(consumer: string, eventId: string): Promise<boolean>;
  /**
   * 登记「已处理」。**必须在副作用成功之后调用**——先登记再执行的话，
   * 处理失败的事件会被永久跳过（静默丢失），比重复投递更糟。
   * 至少一次投递 + 这里的去重 = 恰好一次的副作用（G7）。
   */
  markConsumed(consumer: string, eventId: string): Promise<boolean>;
  /** 恢复所需的非事件状态（定义/契约/计划快照）。 */
  putBlob(kind: string, key: string, body: unknown): Promise<void>;
  getBlob(kind: string, key: string): Promise<unknown | undefined>;
  close(): Promise<void>;
}


/** WAL 记录：一条事件 + 它所属的流。 */
export interface WalRecord {
  streamId: string;
  event: EventEnvelope;
}

/**
 * 写前日志端口（同步）。
 *
 * 领域命令总线是同步的，数据库驱动是异步的；若只依赖异步写库，
 * 进程在「命令已接受、事件未入库」之间崩溃就会丢事件。WAL 在命令被接受之前
 * 同步落盘并 fsync，关掉这个窗口（W5「无丢失」）。
 */
export interface WalSink {
  append(streamId: string, events: readonly EventEnvelope[]): void;
  readAll(): WalRecord[];
}


/**
 * 非事件状态的持久化端口（同步）。
 *
 * 为什么需要它：事件只记录"发生了什么"，续跑还需要"用什么继续"——
 * 编译计划、契约、定义、制品内容、证据记录。此前这些只活在内存里，
 * 崩溃后状态能恢复，活却干不下去。
 *
 * 顺序约定（与 WAL 同理）：**先写 blob，再落引用它的事件**。
 * 崩溃若发生在两者之间，只会留下一份没人引用的 blob，无害；
 * 反过来则会出现"事件引用了一份不存在的计划"，恢复后无法续跑。
 */
export interface StateStore {
  put(kind: string, key: string, body: unknown): void;
  get<T>(kind: string, key: string): T | undefined;
  list<T>(kind: string): Array<{ key: string; body: T }>;
}
