import { expect, it } from 'vitest';
import { guardedHermesApi } from '../src/hermes-extension.js';
it('blocks maintenance subprocess fallback even when direct model completion fails', async () => {
  let executed = false;
  const api = guardedHermesApi({ exec: async () => { executed = true; return { code: 0 }; }, registerTool: (_tool: { name: string }) => {} });
  await expect(api.exec()).rejects.toThrow(/subprocess/);
  expect(executed).toBe(false);
});
it('keeps only durable memory tools from the upstream registration API', () => {
  const exposed: string[] = [];
  const api = guardedHermesApi({ exec: async () => {}, registerTool: (tool: { name: string }) => { exposed.push(tool.name); } });
  for (const name of ['memory_add', 'memory_replace', 'memory_remove', 'memory_search', 'session_search', 'skill_manage']) api.registerTool({ name });
  expect(exposed).toEqual(['memory_add', 'memory_replace', 'memory_remove', 'memory_search']);
});

it('recovers a zero-hit search once without dropping project or target filters', async () => {
  const tools: Record<string, any> = {};
  const api = guardedHermesApi({registerTool: (tool: any) => { tools[tool.name] = tool; }});
  api.registerTool({name: 'memory_search', execute: async (_id: string, args: any) => {
    // A separate-project entry would leak if the retry dropped its scope.
    const entries = [{project: 'alpha', target: 'project', content: 'version-web-assets'}, {project:'beta', target:'user', content:'version-web-assets'}];
    const rows = entries.filter(e => e.project === args.project && e.target === args.target && e.content === args.query);
    return {details: {success: true, count: rows.length}, content: rows};
  }});
  const result = await tools.memory_search.execute('a', {query: 'version-web-assets 静态资源版本号 完整回归', project:'alpha', target:'project'});
  expect(result.content).toEqual([{project:'alpha', target:'project', content:'version-web-assets'}]);
  expect(result.details.searchAttempts).toEqual([{query:'version-web-assets 静态资源版本号 完整回归',count:0}, {query:'version-web-assets',count:1}]);
});

it('stops after two empty searches and does not retry errors or cancelled searches', async () => {
  const tools: Record<string, any> = {};
  const api = guardedHermesApi({registerTool: (tool: any) => { tools[tool.name] = tool; }});
  let calls = 0;
  api.registerTool({name: 'memory_search', execute: async () => { calls++; return {details:{success:true,count:0},content:[]}; }});
  const result = await tools.memory_search.execute('a', {query:'定时会话 北京时间'});
  expect(calls).toBe(2);
  expect(result.details.searchAttempts).toHaveLength(2);
  const signal = AbortSignal.abort();
  await expect(tools.memory_search.execute('b', {query:'定时会话 北京时间'}, signal)).rejects.toThrow(/aborted/);
  expect(calls).toBe(2);
  api.registerTool({name:'memory_search',execute:async () => {calls++; return {isError:true, details:{success:false},content:[]};}});
  expect((await tools.memory_search.execute('c',{query:'定时会话 北京时间'})).isError).toBe(true);
  expect(calls).toBe(3);
});

it('supplies maintenance rules to extraction without mutating the native conversation', async () => {
  const handlers: Record<string, Function> = {};
  const branch = [{type:'message',message:{role:'user',content:'fixture task'}}];
  let extracted: any[] = [], foreground: any[] = [];
  const api = guardedHermesApi({registerTool() {}, on(event: string, handler: Function) {handlers[event]=handler;}});
  api.on('session_shutdown', (_event: any, ctx: any) => {extracted=ctx.sessionManager.getBranch();});
  api.on('before_agent_start', (_event: any, ctx: any) => {foreground=ctx.sessionManager.getBranch();});
  const ctx = {sessionManager:{getBranch:()=>branch}};
  await handlers.session_shutdown({},ctx);
  await handlers.before_agent_start({},ctx);
  expect(extracted).toHaveLength(2);
  expect(extracted[1].message).toMatchObject({role:'custom',customType:'runtime-memory-maintenance-policy'});
  expect(extracted[1].message.content).toContain('needs-verification');
  expect(extracted[1].message.content.length).toBeLessThanOrEqual(500);
  expect(branch).toHaveLength(1);
  expect(foreground).toBe(branch);
});
