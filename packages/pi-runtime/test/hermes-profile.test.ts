import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { initializeHermesProfile, validateHermesProfile, detectHermesProject } from '../src/hermes-profile.js';
import { loadPiCommunityProfile, communityPermissionConfig } from '../src/pi-community-profile.js';
import { preparePiChatBoundary } from '../src/pi-boundary.js';
import { createPiToolGate } from '../src/pi-approval-extension.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hermes-profile-')); roots.push(root);
  const workspace = join(root, 'workspace'), memory = join(root, 'memory'); mkdirSync(workspace);
  initializeHermesProfile(memory); return { root, workspace, memory };
}
it('persists private Pi memory outside workspaces and preserves its identity across leases', () => {
  const t = fixture(), identity = validateHermesProfile(t.memory, t.workspace);
  expect(identity.root).toBe(realpathSync(t.memory)); expect(identity.sourceId).toMatch(/^pi-hermes:/);
  writeFileSync(join(t.memory, 'data', 'saved'), 'persistent');
  expect(readFileSync(join(t.memory, 'data', 'saved'), 'utf8')).toBe('persistent');
  expect(validateHermesProfile(t.memory, t.workspace).sourceId).toBe(identity.sourceId);
  expect(() => validateHermesProfile(t.memory, t.root)).toThrow(/outside/);
  chmodSync(t.memory, 0o755); expect(() => validateHermesProfile(t.memory, t.workspace)).toThrow(/private/);
});
it('refuses unmanaged roots and symlinked data before granting a write root', () => {
  const t = fixture(); expect(() => validateHermesProfile(t.workspace, t.memory)).toThrow();
  rmSync(join(t.memory, 'data'), { recursive: true }); symlinkSync(t.workspace, join(t.memory, 'data'));
  expect(() => validateHermesProfile(t.memory, t.workspace)).toThrow();
});
it('includes Hermes code and scope in the assembly identity and only exposes authorized memory tools', async () => {
  const t = fixture(), modules = join(t.root, 'node_modules');
  const permission = join(modules, '@gotgenes/pi-permission-system'), hermes = join(modules, 'pi-hermes-memory');
  for (const pkg of [permission, hermes]) mkdirSync(join(pkg, 'src'), { recursive: true });
  writeFileSync(join(permission, 'package.json'), JSON.stringify({ name: '@gotgenes/pi-permission-system', version: '40.2.2' }));
  writeFileSync(join(permission, 'src/index.ts'), ''); writeFileSync(join(permission, 'src/service.ts'), '');
  writeFileSync(join(hermes, 'package.json'), JSON.stringify({ name: 'pi-hermes-memory', version: '0.9.10' }));
  writeFileSync(join(hermes, 'src/index.ts'), 'export default function(){}');
  const file = join(t.root, 'profile.json');
  writeFileSync(file, JSON.stringify({ version: 1, permissionPackage: permission, memory: { packageRoot: hermes, storeRoot: t.memory } }));
  const assembled = loadPiCommunityProfile(file, t.workspace);
  expect(assembled.tools).toEqual(expect.arrayContaining(['memory_add', 'memory_replace', 'memory_remove', 'memory_search']));
  expect(assembled.tools).not.toContain('skill_manage'); expect(assembled.tools).not.toContain('session_search');
  const native = await preparePiChatBoundary({workspace:t.workspace, runtimeRoot:join(t.root,'runtime'), guardDir:join(t.root,'guard'), mode:'pi-native', provider:'fixture', nativeMemoryProfilePath:file});
  try {
    expect(native.argsPrefix.at(-1)?.split(',')).toContain('memory_search');
    expect(native.argsPrefix).toContain('--no-mcp');
    expect(native.communityFingerprint).toBeUndefined();
    const entry=native.argsPrefix[native.argsPrefix.indexOf('--extension')+1];
    expect(readFileSync(entry,'utf8')).toContain('installHermesProvenance');
    expect(readFileSync(entry,'utf8')).not.toContain('getPermissionsService');
    // 记忆库不再被整个会话进程独占：并行 Pi 会话可以同时启动；锁只在每次记忆工具调用的瞬间持有
    expect(existsSync(join(t.memory,'runtime.lock'))).toBe(false);
    expect(readFileSync(entry,'utf8')).toContain(JSON.stringify(join(realpathSync(t.memory),'data/.runtime-memory.lock')));
    const second=await preparePiChatBoundary({workspace:t.workspace, runtimeRoot:join(t.root,'runtime2'), guardDir:join(t.root,'guard2'), mode:'pi-native', provider:'fixture', nativeMemoryProfilePath:file});
    await second.dispose();
  } finally { await native.dispose(); }
  const nativeGate=createPiToolGate('pi-native',undefined,true);
  const ctx={hasUI:false,ui:{confirm:async()=>{throw new Error('Native must not prompt');}}};
  expect(await nativeGate({toolName:'memory_add',toolCallId:'native',input:{}},ctx)).toBeUndefined();
  expect(await createPiToolGate('pi-native')({toolName:'memory_add',toolCallId:'off',input:{}},ctx)).toMatchObject({block:true});
  expect(await nativeGate({toolName:'skill_manage',toolCallId:'skill',input:{}},ctx)).toMatchObject({block:true});
  expect(await createPiToolGate('pi-read-only',undefined,true)({toolName:'memory_add',toolCallId:'readonly',input:{}},ctx)).toMatchObject({block:true});
  const gate = createPiToolGate('pi-ask', { tools: assembled.tools, ready: () => true });
  expect(await gate({ toolName: 'memory_add', toolCallId: 'one', input: {} }, { hasUI: true, ui: { confirm: async () => false } })).toBeUndefined();
  expect(await gate({ toolName: 'skill_manage', toolCallId: 'two', input: {} }, { hasUI: true, ui: { confirm: async () => true } })).toMatchObject({ block: true });
  writeFileSync(join(hermes, 'src/index.ts'), 'export default function(){ /* changed */ }');
  expect(loadPiCommunityProfile(file, t.workspace).fingerprint).not.toBe(assembled.fingerprint);
  expect(existsSync(join(t.memory, 'data'))).toBe(true);
  expect(communityPermissionConfig(assembled.tools).permission).toMatchObject({ memory_add: 'allow' });
});

it('detects shared Git/worktree scope and respects the existing migration directory without writing', () => {
  const t=fixture(), repo=join(t.root,'repo'), child=join(repo,'src'), worktree=join(t.root,'feature');
  mkdirSync(join(repo,'.git','worktrees','feature'),{recursive:true}); mkdirSync(child); mkdirSync(worktree);
  writeFileSync(join(worktree,'.git'),`gitdir: ${join(repo,'.git','worktrees','feature')}\n`);
  writeFileSync(join(repo,'.git','worktrees','feature','commondir'),'../..');
  expect(detectHermesProject(child,t.memory)).toBe('repo');
  expect(detectHermesProject(worktree,t.memory)).toBe('repo');
  expect(detectHermesProject(t.workspace,t.memory)).toBe('workspace');
  expect(detectHermesProject(homedir(),t.memory)).toBeNull(); expect(detectHermesProject('/',t.memory)).toBeNull();
  mkdirSync(join(t.memory,'data/projects-memory/feature'));
  expect(detectHermesProject(worktree,t.memory)).toBe('feature');
  mkdirSync(join(t.memory,'data/projects-memory/repo'));
  expect(detectHermesProject(worktree,t.memory)).toBe('repo');
  expect(() => detectHermesProject(join(t.root,'bad\\name'),t.memory)).toThrow();
});

it('resolves an archived removed worktree from the trusted repository hint, including legacy scope',()=>{
 const t=fixture(), repo=join(t.root,'repo'), removed=join(repo,'.pi-worktrees','archived');
 mkdirSync(join(repo,'.git'),{recursive:true});
 expect(detectHermesProject(removed,t.memory,repo)).toBe('repo');
 mkdirSync(join(t.memory,'data/projects-memory/archived'));
 expect(detectHermesProject(removed,t.memory,repo)).toBe('archived');
 expect(()=>detectHermesProject(removed,t.memory,t.workspace)).toThrow();
});
