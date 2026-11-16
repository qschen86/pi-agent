/** Replaced app-server instances must not terminate/project/approve another owner's thread. */
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { CodexAppServerClient } from "../src/codex-client.js";
import { CodexDriver } from "../src/codex.js";
import type { DriverEvent, TurnSink } from "../src/driver.js";
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-app-server.mjs");
const drivers: CodexDriver[] = [];
afterEach(() => {
    for (const driver of drivers.splice(0))
        driver.shutdown();
});
const sink = () => {
    const events: DriverEvent[] = [], approvals: string[] = [];
    const value: TurnSink = {
        nativeSession: () => {
        }, nativeTurn: () => {
        }, event: e => events.push(e), usage: () => {
        }, approval: async (r) => {
            approvals.push(r.nativeRequestId);
            return {
                approve: true, reason: ""
            };
        }, rateLimit: () => {
        }, status: () => {
        }
    };
    return {
        value, events, approvals
    };
};
async function replaced() {
    const clients: CodexAppServerClient[] = [];
    const driver = new CodexDriver({
        binaryPath: process.execPath, clientFactory: () => {
            const c = new CodexAppServerClient({
                binaryPath: process.execPath, args: [fixture], env: {
                    ...process.env as Record<string, string>, FAKE_SCENARIO: "slow"
                }
            });
            clients.push(c);
            return c;
        }
    });
    drivers.push(driver);
    const first = sink();
    const initial = await driver.startTurn({
        workspace: "/tmp", prompt: "old", clientMessageId: "old"
    }, first.value);
    const exit = once(clients[0]!, "exit");
    clients[0]!.stop();
    await exit;
    expect((await initial.done).status).toBe("interrupted");
    const second = sink();
    const active = await driver.startTurn({
        workspace: "/tmp", prompt: "current", clientMessageId: "current"
    }, second.value);
    await new Promise(r => setTimeout(r, 25));
    return {
        driver, old: clients[0]!, current: clients[1]!, active, second
    };
}
it("late exit from a replaced process leaves the current process turn unresolved until its own terminal", async () => {
    const { old, active } = await replaced();
    let result: string | undefined;
    void active.done.then(r => {
        result = r.status;
    });
    old.emit("exit", {
        code: 1, stderrTail: "late old exit"
    });
    await Promise.resolve();
    expect(result).toBeUndefined();
    await active.interrupt();
    expect(await active.done).toMatchObject({
        status: "interrupted", terminalObserved: true
    });
});
it("late foreign process notifications with a colliding original thread ID are not projected", async () => {
    const { old, active, second } = await replaced();
    old.emit("notification", {
        method: "item/completed", params: {
            threadId: "thr-1", turnId: "turn-thr-1-1", item: {
                type: "agentMessage", id: "foreign", text: "foreign process"
            }
        }
    });
    expect(second.events.some(e => e.nativeItemId === "foreign")).toBe(false);
    old.emit("notification", {
        method: "turn/completed", params: {
            threadId: "thr-1", turn: {
                id: "turn-thr-1-1", status: "completed"
            }
        }
    });
    let settled = false;
    void active.done.then(() => {
        settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await active.interrupt();
    expect((await active.done).status).toBe("interrupted");
});
it("foreign process approvals are refused without consulting the current thread human gate", async () => {
    const { old, active, second } = await replaced();
    old.emit("request", {
        id: "foreign-approval", method: "item/commandExecution/requestApproval", params: {
            threadId: "thr-1", turnId: "turn-thr-1-1", command: "foreign operation", cwd: "/tmp"
        }
    });
    await Promise.resolve();
    expect(second.approvals).toEqual([]);
    await active.interrupt();
    await active.done;
});
it("one original thread cannot acquire a second active turn and lose the first operation", async () => {
    const clients: CodexAppServerClient[] = [];
    const driver = new CodexDriver({
        binaryPath: process.execPath, clientFactory: () => {
            const c = new CodexAppServerClient({
                binaryPath: process.execPath, args: [fixture], env: {
                    ...process.env as Record<string, string>, FAKE_SCENARIO: "slow"
                }
            });
            clients.push(c);
            return c;
        }
    });
    drivers.push(driver);
    const a = sink();
    const first = await driver.startTurn({
        workspace: "/tmp", prompt: "first", clientMessageId: "first"
    }, a.value);
    await new Promise(r => setTimeout(r, 25));
    await expect(driver.startTurn({
        nativeSessionId: "thr-1", workspace: "/tmp", prompt: "duplicate", clientMessageId: "duplicate"
    }, sink().value)).rejects.toMatchObject({
        stage: "create", nativeSessionId: "thr-1", notExecuted: true
    });
    expect(await driver.findClientMessage("thr-1", "duplicate")).toBe(false);
    await first.interrupt();
    expect(await first.done).toMatchObject({
        status: "interrupted", terminalObserved: true
    });
});
it("the owning process cannot project an old turn's item into the current turn", async () => {
    const { current, active, second } = await replaced();
    current.emit("notification", {
        method: "item/completed", params: {
            threadId: "thr-1", turnId: "previous-turn", item: {
                type: "agentMessage", id: "old-turn-item", text: "old turn"
            }
        }
    });
    expect(second.events.some(e => e.nativeItemId === "old-turn-item")).toBe(false);
    await active.interrupt();
    await active.done;
});
it("the owning process cannot ask approval for a previous turn", async () => {
    const { current, active, second } = await replaced();
    current.emit("request", {
        id: "old-turn-approval", method: "item/commandExecution/requestApproval", params: {
            threadId: "thr-1", turnId: "previous-turn", command: "old operation", cwd: "/tmp"
        }
    });
    await Promise.resolve();
    expect(second.approvals).toEqual([]);
    await active.interrupt();
    await active.done;
});
it("simultaneous resumes reserve the original thread before awaiting native creation", async () => {
    const { driver, active } = await replaced();
    await active.interrupt();
    await active.done;
    const turns = await Promise.allSettled([driver.startTurn({
            nativeSessionId: "thr-1", workspace: "/tmp", prompt: "race A", clientMessageId: "race-a"
        }, sink().value), driver.startTurn({
            nativeSessionId: "thr-1", workspace: "/tmp", prompt: "race B", clientMessageId: "race-b"
        }, sink().value)]);
    expect(turns.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const rejection = turns.find(r => r.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({
        stage: "create", nativeSessionId: "thr-1", notExecuted: true
    });
    const winner = turns.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<CodexDriver["startTurn"]>>>;
    await new Promise(r => setTimeout(r, 25));
    await winner.value.interrupt();
    await winner.value.done;
});

it("a colliding thread/start response never exposes another operation's native ID as a new binding", async () => {
    let starts = 0;
    const driver = new CodexDriver({
        binaryPath: process.execPath,
        clientFactory: () => {
            const client = new CodexAppServerClient({binaryPath: process.execPath, args: [fixture], env: {...process.env as Record<string,string>, FAKE_SCENARIO: "slow"}});
            const request = client.request.bind(client);
            client.request = (method, params, timeout) => {
                if (method === "thread/start" && starts++ > 0) return Promise.resolve({thread: {id: "thr-1"}});
                return request(method, params, timeout);
            };
            return client;
        }
    });
    drivers.push(driver);
    const first = await driver.startTurn({workspace: "/tmp", prompt: "owner", clientMessageId: "owner"}, sink().value);
    await new Promise(resolve => setTimeout(resolve, 25));
    const foreign = sink();
    const ids: string[] = [];
    foreign.value.nativeSession = id => {ids.push(id);};
    await expect(driver.startTurn({workspace: "/tmp", prompt: "new", clientMessageId: "new"}, foreign.value)).rejects.toMatchObject({stage: "create", nativeSessionId: undefined, notExecuted: true});
    expect(ids).toEqual([]);
    expect(await driver.findClientMessage("thr-1", "new")).toBe(false);
    await first.interrupt();
    expect(await first.done).toMatchObject({status: "interrupted", terminalObserved: true});
});

it.each(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"])("%s without an original turn ID cannot acquire the current turn's approval", async method => {
    const {current, active, second} = await replaced();
    current.emit("request", {id: "missing-turn-approval", method, params: {threadId: "thr-1", command: "ambiguous operation", cwd: "/tmp"}});
    await Promise.resolve();
    expect(second.approvals).toEqual([]);
    await active.interrupt();
    expect(await active.done).toMatchObject({status: "interrupted", terminalObserved: true});
});
