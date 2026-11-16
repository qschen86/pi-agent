/** Real upstream Pi + published Hermes: several native Pi sessions run at once against one memory store. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeHermesProfile } from '../src/hermes-profile.js';
import { HermesMemoryAdapter } from '../../runtime-memory/src/index.js';
const install = process.env.PI_HERMES_INSTALL;
describe.skipIf(!install || process.platform !== 'darwin')('installed Hermes runtime, concurrent sessions', () => {
  it.each(['pi-ask', 'pi-native'])('%s: sessions overlap in time, none is refused, and every write survives', async (mode) => {
    const root = mkdtempSync('/private/tmp/hermes-concurrent-'), source = join(root, 'source'), memory = join(root, 'memory');
    mkdirSync(source); initializeHermesProfile(memory);
    const managed = JSON.parse(readFileSync(join(install!, 'profile.json'), 'utf8'));
    const profile = join(root, 'profile.json');
    writeFileSync(profile, JSON.stringify({ version: 1, permissionPackage: managed.permissionPackage, memory: { packageRoot: managed.memory.packageRoot, storeRoot: memory } }));
    const SESSIONS = Number(process.env.HERMES_SESSIONS ?? 4), running = new Set<string>(); let maxOverlap = 0;
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), flush = !body.tools?.length;
      const prompt = String(body.messages.find((m: any) => m.role === 'user')?.content?.[0]?.text ?? body.messages.find((m: any) => m.role === 'user')?.content ?? '');
      const name = /session-(\d+)/.exec(prompt)?.[1] ?? 'flush';
      const result = body.messages.find((m: any) => m.role === 'tool');
      // Keep every session in flight long enough that they all overlap.
      if (!flush && !result) { running.add(name); maxOverlap = Math.max(maxOverlap, running.size); await new Promise(r => setTimeout(r, 2500)); }
      const delta = flush ? { role: 'assistant', content: JSON.stringify({ operations: [] }) }
        : result ? { role: 'assistant', content: 'concurrent fixture done' }
        : { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture_memory', type: 'function', function: { name: 'memory_add', arguments: JSON.stringify({ target: 'project', content: `concurrent_canary_${name} durable fact` }) } }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [d, finish] of [[delta, null], [{}, flush || result ? 'stop' : 'tool_calls']]) res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'probe', choices: [{ index: 0, delta: d, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    writeFileSync(join(source, 'settings.json'), '{}');
    writeFileSync(join(source, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`, api: 'openai-completions', apiKey: 'synthetic-only', models: [{ id: 'probe', name: 'probe', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }] } } }));
    const launchSession = (n: number) => {
      const workspace = join(root, `ws-${n}`, 'alpha'); mkdirSync(workspace, { recursive: true });
      const launch = join(root, `launch-${n}.json`);
      writeFileSync(launch, JSON.stringify({ version: 1, binary: '/opt/homebrew/bin/pi', workspace, mode, provider: 'fixture', model: 'probe', sessionId: randomUUID(), sourceAgentDir: source, memorySource: { platformSessionId: `rt-concurrent-${n}`, turnId: `turn-${n}` } }));
      const child = spawn(join(install!, 'bin/pi-runtime'), ['--profile', profile, '--launch-spec', launch, '--cwd', workspace, '--state-dir', join(root, `state-${n}`), '--pi-binary', '/opt/homebrew/bin/pi', '--provider', 'fixture', '--model', 'probe', '--prompt', `Run session-${n} action once.`], { cwd: '/private/tmp', env: { ...process.env, PI_CODING_AGENT_DIR: source }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
      const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
      return new Promise<{ code: number | null; out: string }>((resolve, reject) => { child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, out: stderr + stdout }); }); });
    };
    try {
      const results = await Promise.all(Array.from({ length: SESSIONS }, (_, i) => launchSession(i + 1)));
      if (process.env.HERMES_KEEP) results.forEach((r, i) => writeFileSync(join(root, `out-${i + 1}.log`), r.out));
      if (process.env.HERMES_DEBUG) results.forEach((r, i) => console.log(mode, 'LOG', i + 1, r.out.split('\n').filter(l => /warn|⚠|error|locked|busy|progress|sync|reconcil|removed|import/i.test(l)).slice(0, 12).join(' | ')));
      for (const r of results) { expect(r.out).not.toMatch(/busy|runtime\.lock/i); expect(r.code, r.out).toBe(0); expect(r.out).toContain('concurrent fixture done'); }
      // They really ran at the same time (the old process-wide lock would refuse all but one).
      expect(maxOverlap).toBeGreaterThanOrEqual(2);
      const entries = (await new HermesMemoryAdapter({ databasePath: join(memory, 'data/global/sessions.db'), sourceId: JSON.parse(readFileSync(join(memory, 'pi-runtime-memory.json'), 'utf8')).sourceId, project: 'alpha' }).readSnapshot()).entries.map(e => e.content).sort();
      if (process.env.HERMES_DEBUG) { const { execSync } = await import('node:child_process'); console.log(mode, 'MD:', execSync(`cat ${memory}/data/projects-memory/alpha/MEMORY.md 2>&1; echo; sqlite3 ${memory}/data/global/sessions.db "select id,project,target,substr(content,1,40) from memories" 2>&1; sqlite3 ${memory}/data/global/sessions.db "select kind,memory_id,json_extract(origin,'$.platformSessionId'),json_extract(origin,'$.trigger') from runtime_memory_writes order by seq"`).toString()); }
      expect(entries).toEqual(Array.from({ length: SESSIONS }, (_, i) => `concurrent_canary_${i + 1} durable fact`));
      expect(existsSync(join(memory, 'data/.runtime-memory.lock'))).toBe(false);
      expect(existsSync(join(memory, 'runtime.lock'))).toBe(false);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); if (!process.env.HERMES_KEEP) rmSync(root, { recursive: true, force: true }); else console.log('KEPT', root); }
  }, 150000);
});
