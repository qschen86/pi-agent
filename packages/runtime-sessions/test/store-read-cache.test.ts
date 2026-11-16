/**
 * 权威文件的只读缓存：文件身份（inode / 大小 / 时间）没变就不重读、不解析、不逐条比对。
 * 现场：usage.json 18 MB，每次读会话画面都整份重读，事件循环每次停 0.3–1 秒。
 * 这里确认缓存不牺牲「读到的就是磁盘上的权威内容」：外部改写能看到、写失败后回到磁盘内容。
 */
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { RuntimeStore } from "../src/store.js";
import type { ApprovalRequest, UsageRecord } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const fresh = () => { const dir = mkdtempSync(join(tmpdir(), "rt-read-cache-")); dirs.push(dir); return new RuntimeStore(dir); };
const usage = (requestId: string, input: number): UsageRecord => ({ usageScope: "request", counterMode: "delta", requestId, input, output: 1, semantics: "test" } as UsageRecord);
const approval = (approvalId: string, state = "pending"): ApprovalRequest => ({ approvalId, platformSessionId: "rt-a", state, title: "t" } as unknown as ApprovalRequest);

it("sees another process's atomic rewrite and in-place rewrite of an authority file", () => {
  const store = fresh();
  store.addUsage("rt-a", usage("r1", 10));
  expect(store.usageFor("rt-a").map((r) => r.input)).toEqual([10]);
  // 另一个槽位用临时文件改名整体写入
  const file = join(store.dir, "usage.json");
  const other = JSON.parse(readFileSync(file, "utf8")); other["rt-a"].push(usage("r2", 20));
  writeFileSync(`${file}.ext`, JSON.stringify(other)); renameSync(`${file}.ext`, file);
  expect(store.usageFor("rt-a").map((r) => r.input)).toEqual([10, 20]);
  // 原地改写（不换 inode）也要看出来
  other["rt-a"].push(usage("r3", 30)); writeFileSync(file, JSON.stringify(other));
  expect(store.usageFor("rt-a").map((r) => r.input)).toEqual([10, 20, 30]);
  expect(store.allUsage()["rt-a"]!.length).toBe(3);
});

it("own writes are visible immediately and a removed file empties the table", () => {
  const store = fresh();
  store.putApproval(approval("ap-1"));
  expect(store.approval("ap-1")?.state).toBe("pending");
  const live = store.approval("ap-1")!; (live as unknown as { state: string }).state = "approved"; store.putApproval(live);
  expect(store.approval("ap-1")?.state).toBe("approved");
  rmSync(join(store.dir, "approvals.json"));
  expect(store.approval("ap-1")).toBeUndefined();
});

it("a failed write that already mutated the cached record is rolled back on the next read", () => {
  const store = fresh();
  store.putApproval(approval("ap-1"));
  const cached = store.approval("ap-1")!;
  // 别的宿主先改了这条记录：本进程基于旧版本就地修改后写入 → 冲突
  const file = join(store.dir, "approvals.json");
  const disk = JSON.parse(readFileSync(file, "utf8")); disk["ap-1"].title = "external";
  writeFileSync(`${file}.ext`, JSON.stringify(disk)); renameSync(`${file}.ext`, file);
  (cached as unknown as { state: string }).state = "denied";
  expect(() => store.putApproval(cached)).toThrow(/写入冲突/);
  expect(store.approval("ap-1")).toMatchObject({ state: "pending", title: "external" });
});

it("repeated reads of an unchanged large table do not re-parse it", () => {
  const store = fresh();
  const big: Record<string, UsageRecord[]> = {};
  for (let s = 0; s < 400; s++) big[`rt-${s}`] = Array.from({ length: 60 }, (_, i) => usage(`req-${s}-${i}`, i));
  writeFileSync(join(store.dir, "usage.json"), JSON.stringify(big));
  store.usageFor("rt-0"); // 第一次完整读取
  const started = performance.now();
  for (let i = 0; i < 200; i++) expect(store.usageFor(`rt-${i}`).length).toBe(60);
  // 旧实现每次都重读并逐条比对（这份数据每次数十毫秒）；命中缓存只剩一次 stat
  expect(performance.now() - started).toBeLessThan(500);
});

it("appending usage reuses the in-memory table when the file is unchanged, but still picks up another process's rows", () => {
  const store = fresh();
  store.addUsage("rt-a", usage("r1", 10));
  store.addUsage("rt-a", usage("r1", 11)); // 同一请求覆盖
  const file = join(store.dir, "usage.json");
  const disk = JSON.parse(readFileSync(file, "utf8")); disk["rt-b"] = [usage("x", 5)];
  writeFileSync(`${file}.ext`, JSON.stringify(disk)); renameSync(`${file}.ext`, file);
  store.addUsage("rt-a", usage("r2", 20));
  const after = JSON.parse(readFileSync(file, "utf8"));
  expect(after["rt-a"].map((r: UsageRecord) => r.input)).toEqual([11, 20]);
  expect(after["rt-b"].map((r: UsageRecord) => r.input)).toEqual([5]);
  expect(new RuntimeStore(join(store.dir, "..")).usageFor("rt-a").map((r) => r.input)).toEqual([11, 20]);
});
