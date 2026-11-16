/** Real upstream Pi + published Hermes + native SQLite, with a deterministic local model. */
import {randomUUID} from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeHermesProfile, validateHermesProfile } from '../src/hermes-profile.js';
import { HermesMemoryAdapter } from '../../runtime-memory/src/index.js';
const install = process.env.PI_HERMES_INSTALL;
describe.skipIf(!install || process.platform !== 'darwin')('installed Hermes runtime', () => {
  it.each(['pi-ask','pi-native'])('%s saves, recalls, updates and forgets across real process exits', async (mode) => {
    const root = mkdtempSync('/private/tmp/hermes-live-'), workspace = join(root, 'alpha'), source = join(root, 'source'), memory = join(root, 'memory');
    mkdirSync(workspace); mkdirSync(source); initializeHermesProfile(memory);
    writeFileSync(join(memory, 'startup-policy.json'), JSON.stringify({version:1,corePreferences:['startup_core_canary'],projects:{alpha:['startup_alpha_index_canary'],beta:['other_project_secret_canary']}}),{mode:0o600});
    const managed = JSON.parse(readFileSync(join(install!, 'profile.json'), 'utf8'));
    const profile = join(root, 'profile.json');
    writeFileSync(profile, JSON.stringify({ version: 1, permissionPackage: managed.permissionPackage, memory: { packageRoot: managed.memory.packageRoot, storeRoot: memory } }));
    let selectedModel='probe',turn=0,prompt='Execute the fixture action once.',automaticContent='automatic_flush_canary';
    let tool = 'memory_add', args: Record<string, unknown> = { target: 'project', content: 'hermes_canary_sqlite durable fact' };
    let toolResult = '', exposed: string[] = [], flushes = 0, automatic = false, failDirect = false, requests = 0, startupPrompts: string[] = [], maintenancePrompts: string[] = [];
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), flush = !body.tools?.length;
      requests++;
      if (!flush) exposed = body.tools.map((t: any) => t.function.name);
      if (!flush) startupPrompts.push(JSON.stringify(body.messages.filter((m:any)=>m.role==='system')));
      const result = body.messages.find((m: any) => m.role === 'tool');
      if (result) toolResult = JSON.stringify(result);
      if (flush) { flushes++; maintenancePrompts.push(JSON.stringify(body.messages)); await new Promise(r => setTimeout(r, 250)); }
      const delta = flush ? { role: 'assistant', content: failDirect ? 'invalid memory completion' : JSON.stringify({ operations: automatic ? [{ action: 'add', target: 'project', content: automaticContent }] : [] }) }
        : result || automatic ? { role: 'assistant', content: 'hermes fixture done' } : { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture_memory', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [d, finish] of [[delta, null], [{}, flush || result || automatic ? 'stop' : 'tool_calls']]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'probe', choices: [{ index: 0, delta: d, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    writeFileSync(join(source, 'settings.json'), '{}');
    writeFileSync(join(source, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, api: 'openai-completions', apiKey: 'synthetic-only', models: ['probe','probe-b'].map(id=>({id,name:id,reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:32000,maxTokens:1024})) } } }));
    const adapter = new HermesMemoryAdapter({ databasePath: join(memory, 'data/global/sessions.db'), sourceId: validateHermesProfile(memory, workspace).sourceId, project: 'alpha' });
    let legacySession: {id:string;file:string}|undefined;
    const plainProfile=join(root,'plain-profile.json');
    writeFileSync(plainProfile,JSON.stringify({version:1,permissionPackage:managed.permissionPackage}));
    async function run(withMemory=true) {
      toolResult = '';if(withMemory)turn++;
      const id=legacySession?.id??randomUUID();
      const resume=legacySession?.file;
      legacySession=undefined;
      const launch=join(root,'launch.json');writeFileSync(launch,JSON.stringify({version:1,binary:'/opt/homebrew/bin/pi',workspace,mode,provider:'fixture',model:selectedModel,sessionId:id,...(resume?{sessionFile:resume}:{}),sourceAgentDir:source,memorySource:{platformSessionId:`rt-live-${turn}`,turnId:`turn-${turn}`}}));
      const child = spawn(join(install!, 'bin/pi-runtime'), ['--profile', withMemory?profile:plainProfile, '--launch-spec',launch,'--cwd', workspace, '--state-dir', join(root, 'state'), '--pi-binary', '/opt/homebrew/bin/pi', '--provider', 'fixture', '--model', 'probe', '--prompt', prompt], { cwd: '/private/tmp', env: { ...process.env, PI_CODING_AGENT_DIR: source }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
      const timer = setTimeout(() => child.kill('SIGKILL'), 35000);
      try {
        const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        expect(code, stderr + stdout).toBe(0); expect(stdout).toContain('hermes fixture done');
        if(withMemory){
        if (!automatic) expect(toolResult).not.toBe(''); expect(toolResult).not.toContain('blocked');
        expect(exposed).toContain('memory_search'); expect(exposed).not.toContain('session_search'); expect(exposed).not.toContain('skill_manage');
        } else {
          expect(exposed).not.toContain('memory_search');
          legacySession={id,file:join(root,'state/sessions',`${id}.jsonl`)};
        }
        if(mode==='pi-native') {
          expect(exposed).toEqual(expect.arrayContaining(['read','write','edit','bash']));
          expect(exposed).not.toContain('bash_escalated');
          const history=readFileSync(join(root,'state/sessions',`${id}.jsonl`),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
          expect(history.filter(row=>row.customType==='pi-runtime-assembly').at(-1)?.data.fingerprint).toBe('legacy');
        }
        expect(existsSync(join(memory, 'runtime.lock'))).toBe(false);
      } finally { clearTimeout(timer); child.kill('SIGKILL'); }
    }
    try {
      if(mode==='pi-native'){automatic=true;await run(false);automatic=false;}
      await run(); const first = await adapter.readSnapshot();
      expect(first.entries.map(e => e.content)).toEqual(['hermes_canary_sqlite durable fact']);
      tool = 'memory_search'; args = { query: 'hermes_canary_sqlite' }; await run();
      expect(toolResult).toContain('hermes_canary_sqlite durable fact');
      expect(adapter.readSessionEvents('rt-live-1').events).toMatchObject([{kind:'add',entry:{content:'hermes_canary_sqlite durable fact'}}]);
      expect(adapter.readSessionEvents('rt-live-2').events).toMatchObject([{kind:'injected',origin:{model:'probe',query:'hermes_canary_sqlite',queryMethod:'fts5'},entry:{content:'hermes_canary_sqlite durable fact'}}]);
      expect(adapter.getChanges(first, await adapter.readSnapshot())).toEqual([]);
      expect(first.entries[0].provenance?.first).toMatchObject({platformSessionId:'rt-live-1',turnId:'turn-1',model:'probe',trigger:'memory-tool'});
      selectedModel='probe-b';
      tool = 'memory_replace'; args = { target: 'project', old_text: 'hermes_canary_sqlite', content: 'hermes_canary_postgresql durable fact' }; await run();
      const changed = await adapter.readSnapshot(); expect(changed.entries.map(e => e.content)).toEqual(['hermes_canary_postgresql durable fact']);
      expect(changed.entries[0].provenance?.last).toMatchObject({platformSessionId:'rt-live-3',model:'probe-b'});
      expect(adapter.getChanges(first, changed).length).toBeGreaterThan(0);
      tool = 'memory_remove'; args = { target: 'project', old_text: 'hermes_canary_postgresql' }; await run();
      const removed = await adapter.readSnapshot(); expect(removed.entries).toEqual([]);
      expect(adapter.readSessionEvents('rt-live-2').events[0]?.entry.content).toBe('hermes_canary_sqlite durable fact');
      expect(adapter.readSessionEvents('rt-live-4').events).toMatchObject([{kind:'delete',entry:{content:'hermes_canary_postgresql durable fact'},origin:{platformSessionId:'rt-live-4',trigger:'memory-tool'}}]);
      expect(removed.writes?.filter(w=>w.kind==='delete').at(-1)?.origin).toMatchObject({platformSessionId:'rt-live-4',model:'probe-b'});
      expect(adapter.getChanges(changed, removed).map(d => d.kind)).toEqual(['delete']);
      expect(existsSync(join(memory, 'data/projects-memory/alpha/MEMORY.md'))).toBe(true);
      automatic = true; await run();
      expect(flushes).toBeGreaterThan(0);
      expect(maintenancePrompts.at(-1)).toContain('Runtime memory maintenance policy');
      expect(maintenancePrompts.at(-1)).toContain('needs-verification');
      expect((await adapter.readSnapshot()).entries.map(e => e.content)).toEqual(['automatic_flush_canary']);
      const auto=(await adapter.readSnapshot()).entries[0];expect(auto.provenance?.last).toMatchObject({platformSessionId:'rt-live-5',model:'probe-b',trigger:'shutdown-flush'});
      failDirect = true;
      const requestCount = requests;
      await run();
      expect(startupPrompts.at(-1)).toContain('startup_core_canary');
      expect(startupPrompts.at(-1)).toContain('startup_alpha_index_canary');
      expect(startupPrompts.at(-1)).not.toContain('other_project_secret_canary');
      // One foreground call and one direct flush; no unguarded child Pi retry after invalid completion.
      expect(requests - requestCount).toBe(2);
      expect((await adapter.readSnapshot()).entries.map(e => e.content)).toEqual(['automatic_flush_canary']);
      failDirect=false;automaticContent='correction_capture_canary';prompt='no, use pnpm instead of npm';
      await run();
      expect((await adapter.readSnapshot()).writes?.some(w=>w.origin.trigger==='correction-save' && w.entry?.content==='correction_capture_canary')).toBe(true);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true }); }
  }, 150000);
});
