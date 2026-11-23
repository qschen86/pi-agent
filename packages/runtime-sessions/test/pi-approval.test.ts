import { afterEach, expect, it, vi } from "vitest";
import install, { createPiToolGate } from "../src/pi-approval-extension.js";

const action = (toolName: string, toolCallId = "action-1") => ({ toolName, toolCallId, input: { command: "echo hello", path: "result.txt", content: "hello" } });
it.each(["write", "edit", "bash"])("denying %s prevents the tool body from executing", async (tool) => {
  const gate = createPiToolGate("pi-ask"); let executions = 0;
  const result = await gate(action(tool), { hasUI: true, ui: { confirm: async () => false } });
  if (!result?.block) executions++;
  expect(executions).toBe(0);
});
it("approval cannot be reused for another action or the same action twice", async () => {
  const gate = createPiToolGate("pi-ask"); let executions = 0;
  const ctx = { hasUI: true, ui: { confirm: async (_title: string, message: string) => JSON.parse(message).toolCallId === "allowed-1" } };
  for (const id of ["allowed-1", "allowed-1", "denied-2"]) if (!(await gate(action("write", id), ctx))?.block) executions++;
  expect(executions).toBe(1);
});
it.each(["pi-read-only", "pi-ask", "pi-native", "pi-evaluation"])("blocks unknown extension tools in %s", async (mode) => {
  expect(await createPiToolGate(mode)(action("surprise-plugin"), { hasUI: true, ui: { confirm: async () => true } })).toMatchObject({ block: true });
});
it("read-only permits read/search but forbids every mutation tool", async () => {
  const gate = createPiToolGate("pi-read-only");
  const ctx = { hasUI: false, ui: { confirm: async () => true } };
  for (const tool of ["write", "edit", "bash"]) expect(await gate(action(tool, tool), ctx)).toMatchObject({ block: true });
  for (const tool of ["read", "grep", "find", "ls"]) expect(await gate(action(tool, tool), ctx)).toBeUndefined();
});
it("missing UI, dialog errors and abort after approval all fail closed", async () => {
  const gate = createPiToolGate("pi-ask");
  expect(await gate(action("bash", "no-ui"), { hasUI: false, ui: { confirm: async () => true } })).toMatchObject({ block: true });
  expect(await gate(action("bash", "timeout"), { hasUI: true, ui: { confirm: async () => { throw new Error("timeout"); } } })).toMatchObject({ block: true });
  const ctrl = new AbortController();
  expect(await gate(action("bash", "abort"), { hasUI: true, signal: ctrl.signal, ui: { confirm: async () => { ctrl.abort(); return true; } } })).toMatchObject({ block: true });
});

it("host-authorized evaluation tools run without UI while duplicate and unknown calls remain blocked", async () => {
  const gate = createPiToolGate("pi-evaluation");
  const ctx = { hasUI: false, ui: { confirm: async () => { throw new Error("must not ask"); } } };
  expect(await gate(action("write", "report"), ctx)).toBeUndefined();
  expect(await gate(action("write", "report"), ctx)).toMatchObject({ block: true });
  expect(await gate(action("surprise", "plugin"), ctx)).toMatchObject({ block: true });
});

const oldMode=process.env.PI_CHAT_PERMISSION_MODE,oldToken=process.env.PI_CHAT_GATE_TOKEN;
afterEach(()=>{vi.unstubAllEnvs();if(oldMode===undefined)delete process.env.PI_CHAT_PERMISSION_MODE;else process.env.PI_CHAT_PERMISSION_MODE=oldMode;if(oldToken===undefined)delete process.env.PI_CHAT_GATE_TOKEN;else process.env.PI_CHAT_GATE_TOKEN=oldToken;});
it("attests actual registered builtin sources and active tools through the original native Pi API",()=>{
 // 本用例不关心平台浏览器：宿主（pi 会话）带着 PI_PLATFORM_BROWSER_SOCKET 时也必须得到同样的结果。
 vi.stubEnv("PI_PLATFORM_BROWSER_SOCKET","");
 process.env.PI_CHAT_PERMISSION_MODE="pi-evaluation";process.env.PI_CHAT_GATE_TOKEN="host-startup-nonce";
 const callbacks:Record<string,any>={},messages:string[]=[];
 install({on:(name:string,callback:any)=>{callbacks[name]=callback;},getActiveTools:()=>["read","write"],getAllTools:()=>[{name:"read",sourceInfo:{source:"builtin"}},{name:"write",sourceInfo:{source:"builtin"}}]});
 callbacks.session_start({}, {ui:{notify:(message:string)=>messages.push(message)}});
 const message=messages.find(m=>m.startsWith("pi-chat-evaluation-tools:"));expect(message).toBeDefined();
 expect(JSON.parse(message!.slice("pi-chat-evaluation-tools:".length))).toEqual({version:1,token:"host-startup-nonce",activeTools:["read","write"],registeredTools:[{name:"read",source:"builtin"},{name:"write",source:"builtin"}]});
});
it("session start fails closed when the platform browser socket is set but the browser tool is not active", () => {
  vi.stubEnv("PI_PLATFORM_BROWSER_SOCKET", "/tmp/platform-browser.sock");
  const callbacks: Record<string, any> = {};
  install({ on: (name: string, callback: any) => { callbacks[name] = callback; }, getActiveTools: () => ["read"], getAllTools: () => [] });
  expect(() => callbacks.session_start({}, { ui: { notify: () => {} } })).toThrow("Platform browser tool missing from active Pi inventory");
  callbacks.session_start = undefined;
  const ok: Record<string, any> = {};
  install({ on: (name: string, callback: any) => { ok[name] = callback; }, getActiveTools: () => ["read", "platform_browser"], getAllTools: () => [] });
  expect(() => ok.session_start({}, { ui: { notify: () => {} } })).not.toThrow();
});
it("does not impose a native deadline on a human decision", async () => {
  const { createPiToolGate } = await import("../src/pi-approval-extension.js");
  let seen: number | undefined;
  const r = await createPiToolGate("pi-ask")({ toolName: "write", toolCallId: "w1", input: {} }, { hasUI: true, ui: { confirm: async (_t, _m, o) => { seen = o?.timeout; return true; } } });
  expect(r).toBeUndefined(); expect(seen).toBeUndefined();
});

it("only ordinary ask mode registers host execution, sending the exact request and returning its result", async () => {
  const { createPiEscalationTool } = await import("../src/pi-approval-extension.js");
  const tool = createPiEscalationTool();
  const input = { command: "git add file.txt", capability: "git", reason: "Git index is outside the worktree", timeout: 30 };
  let sent: unknown;
  const result = await tool.execute("call-one", input, undefined, undefined, { hasUI: true, ui: { input: async (_title: string, placeholder: string) => { sent = JSON.parse(placeholder); return JSON.stringify({ output: "committed", exitCode: 0 }); } } });
  expect(sent).toEqual({ ...input, toolCallId: "call-one" });
  expect(result.content[0].text).toContain("committed"); expect(result.details.exitCode).toBe(0);
  expect(await createPiToolGate("pi-ask")(action("bash_escalated"), { hasUI: true, ui: { confirm: async () => { throw new Error("separate host approval only"); } } })).toBeUndefined();
  expect(await createPiToolGate("pi-read-only")(action("bash_escalated"), { hasUI: true, ui: { confirm: async () => true } })).toMatchObject({ block: true });
});
it.each(['pi-native','pi-ask','pi-evaluation'])('screenshot policy blocks before permission grants in %s',async mode=>{
 vi.stubEnv('PI_PLATFORM_BROWSER_SOCKET','/tmp/platform-browser.sock');
 const result=await createPiToolGate(mode)({toolName:'bash',toolCallId:'capture',input:{command:'node -e "page.screenshot()"'}},{hasUI:true,ui:{confirm:async()=>true}});
 expect(result).toMatchObject({block:true,reason:expect.stringContaining('SCREENSHOT_TOOL_REQUIRED')});vi.unstubAllEnvs();
});
it("codemode itself passes outside evaluation, while its nested mutation calls still hit the gate", async () => {
  const ctx = { hasUI: false, ui: { confirm: async () => true } };
  for (const mode of ["pi-read-only", "pi-ask", "pi-native"]) expect(await createPiToolGate(mode)(action("codemode", "cm"), ctx)).toBeUndefined();
  expect(await createPiToolGate("pi-evaluation")(action("codemode", "cm"), ctx)).toMatchObject({ block: true });
  const readOnly = createPiToolGate("pi-read-only");
  for (const tool of ["write", "edit", "bash"]) expect(await readOnly(action(tool, `nested-${tool}`), ctx)).toMatchObject({ block: true });
});
