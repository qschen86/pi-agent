import { describe, expect, it } from "vitest";
import { BackgroundJobs, MAX_RUNNING_JOBS, describeJob, type RunBash } from "../src/background-jobs.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 受控的假执行：外部决定何时出输出、何时结束；被 abort 时按内置 bash 的行为 reject。 */
function fake() {
  let emit!: (text: string) => void, finish!: (r: { text: string; isError: boolean; exitCode?: number }) => void;
  const run: RunBash = (signal, onOutput) => new Promise((resolve, reject) => {
    emit = (t) => onOutput(t);
    finish = resolve;
    signal.addEventListener("abort", () => reject(new Error("partial output\n\nCommand aborted")), { once: true });
  });
  return { run, emit: (t: string) => emit(t), finish: (r: { text: string; isError: boolean; exitCode?: number }) => finish(r) };
}

describe("BackgroundJobs", () => {
  it("启动后立刻返回任务号，输出随执行更新，结束后记下退出码", async () => {
    const jobs = new BackgroundJobs(), f = fake();
    const started = jobs.start("npm test", f.run)!;
    expect(started).toMatchObject({ id: "job-1", status: "running", command: "npm test" });
    f.emit("line 1");
    expect(jobs.get("job-1")!.output).toBe("line 1");
    f.finish({ text: "line 1\ndone", isError: false, exitCode: 0 });
    await jobs.output("job-1", 5);
    expect(jobs.get("job-1")).toMatchObject({ status: "exited", exitCode: 0, output: "line 1\ndone" });
  });

  it("非零退出码记为失败并保留输出", async () => {
    const jobs = new BackgroundJobs(), f = fake();
    jobs.start("false", f.run);
    f.finish({ text: "boom\n\nCommand exited with code 2", isError: true, exitCode: 2 });
    const v = (await jobs.output("job-1", 5))!;
    expect(v).toMatchObject({ status: "failed", exitCode: 2 });
    expect(describeJob(v)).toContain("退出码 2");
  });

  it("等待到结束就返回，不会等满；等待期间每次新输出回调一次进度", async () => {
    const jobs = new BackgroundJobs(), f = fake();
    jobs.start("slow", f.run);
    const progress: string[] = [];
    const started = Date.now();
    const waiting = jobs.output("job-1", 30, undefined, (v) => progress.push(v.output));
    await tick(700); f.emit("half");
    await tick(700); f.finish({ text: "all", isError: false, exitCode: 0 });
    const v = (await waiting)!;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(v.status).toBe("exited");
    expect(progress).toContain("half");
  });

  it("等够时间还没结束就返回仍在运行", async () => {
    const jobs = new BackgroundJobs(), f = fake();
    jobs.start("slow", f.run);
    const v = (await jobs.output("job-1", 1))!;
    expect(v.status).toBe("running");
    await jobs.kill("job-1");
  });

  it("等待可被 signal 打断", async () => {
    const jobs = new BackgroundJobs(), f = fake(), ctl = new AbortController();
    jobs.start("slow", f.run);
    const waiting = jobs.output("job-1", 30, ctl.signal);
    setTimeout(() => ctl.abort(), 100);
    expect((await waiting)!.status).toBe("running");
    await jobs.kill("job-1");
  });

  it("kill 终止任务并记为已终止；对已结束的任务是空操作", async () => {
    const jobs = new BackgroundJobs(), f = fake();
    jobs.start("sleep 999", f.run);
    expect((await jobs.kill("job-1"))!.status).toBe("killed");
    const g = fake();
    jobs.start("echo", g.run);
    g.finish({ text: "ok", isError: false, exitCode: 0 });
    await jobs.output("job-2", 5);
    expect((await jobs.kill("job-2"))!.status).toBe("exited");
  });

  it("同时运行数有上限，结束或终止后释放名额", async () => {
    const jobs = new BackgroundJobs();
    for (let i = 0; i < MAX_RUNNING_JOBS; i++) expect(jobs.start(`c${i}`, fake().run)).toBeDefined();
    expect(jobs.start("one-too-many", fake().run)).toBeUndefined();
    await jobs.kill("job-1");
    expect(jobs.start("now-fits", fake().run)).toBeDefined();
    await jobs.killAll();
    expect(jobs.running()).toBe(0);
  });

  it("未知任务号返回 undefined；输出只给尾部", async () => {
    const jobs = new BackgroundJobs(), f = fake();
    expect(jobs.get("job-9")).toBeUndefined();
    expect(await jobs.output("job-9", 0)).toBeUndefined();
    expect(await jobs.kill("job-9")).toBeUndefined();
    jobs.start("big", f.run);
    f.emit("x".repeat(30_000));
    expect(jobs.get("job-1")!.output.length).toBeLessThan(13_000);
    await jobs.killAll();
  });
});
