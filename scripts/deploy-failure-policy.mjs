// Durable negative receipts. A failure is never evidence that a deployment passed.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, delimiter } from 'node:path';
import { platform, arch, release } from 'node:os';
import { fileURLToPath } from 'node:url';

export const hash = value => createHash('sha256').update(value).digest('hex');
export function writeResult(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}
export function readResult(file) {
  try { const v = JSON.parse(readFileSync(file, 'utf8')); return v.version === 1 ? v : undefined; }
  catch { return undefined; }
}
export function classifyFailure(error) {
  const primary = String(error).replace(/\u001b\[[0-9;]*m/g, '').trim().split('\n')[0];
  if (/^(?:AssertionError|SyntaxError|ReferenceError|TypeError)\b/.test(primary)) return 'deterministic';
  if (/timeout|timed out|Matcher did not succeed/i.test(error)) return 'timeout';
  if (/AssertionError|SyntaxError|ReferenceError|TypeError|error TS\d+|expected .* (?:to|not to) /is.test(error)) return 'deterministic';
  if (/ECONNRESET|EAI_AGAIN|ETIMEDOUT|browser.*(?:closed|crash)|Target.*closed/i.test(error)) return 'transient';
  return 'unknown';
}
export function reportFailures(report, repo, files) {
  const wanted = new Set(files), out = [];
  for (const r of report.testResults ?? []) {
    const file = relative(repo, r.name);
    if (r.status !== 'failed' || !wanted.has(file)) continue;
    const assertions = (r.assertionResults ?? []).filter(a => a.status === 'failed');
    for (const a of assertions.length ? assertions : [null]) {
      const error = String(a?.failureMessages?.join('\n') || r.message || '');
      out.push({ file, test: a?.fullName ?? a?.title ?? '<file>', kind: classifyFailure(error), error });
    }
  }
  return out;
}
/**
 * 候选红了以后要不要单独、串行复跑一次再下结论。
 * 11-22 起只给「全是超时 / 临时故障」的复跑，断言或混合失败第一次红就拦。可门禁并发跑上百个浏览器用例时，
 * 按时间断言的用例（长按 150ms、轮询次数、等文件选择框）在负载下会以 AssertionError / TypeError 的形式偶发红，
 * 线上对照又是低负载串行跑、照样绿，于是被当成「这次改坏了」打回去，改动要隔几小时才上线。
 * 现在：只有文件根本加载不了（语法 / 引用错误、类型错误码、模块解析失败）和认不出原因的不复跑，其余都串行确认一次。
 */
const LOAD_ERROR = /^(?:SyntaxError|ReferenceError)\b|error TS\d+|Failed to load url|Cannot find module|does not provide an export named/m;
export const mayConfirm = failures => failures.length > 0 && failures.every(f => f.kind !== 'unknown' && !LOAD_ERROR.test(String(f.error ?? '').replace(/\u001b\[[0-9;]*m/g, '')));
export function failureFingerprint(failures) {
  return hash(JSON.stringify(failures.map(f => ({ ...f, error: f.error
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\b\d{4}-\d\d-\d\dT[\d:.]+Z\b/g, '<time>')
    .replace(/(?:\/private)?\/(?:tmp|var\/folders)\/[^\s)]+/g, '<temp>')
    .replace(/(https?:\/\/(?:localhost|127\.0\.0\.1):)\d+/g, '$1<port>')
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))));
}
export function failureResult({ key, failures, phase, confirmations = 0, ...rest }) {
  return { version: 1, status: 'failed', key, phase, failures, fingerprint: failureFingerprint(failures), confirmations, ...rest, at: new Date().toISOString() };
}
const git = (repo, ...args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) throw new Error(`无法核实部署检查身份：${args[0]}`);
  return r.stdout.trim();
};
const fileIdentity = file => {
  try { const st = statSync(file); return { size: st.size, mtime: st.mtimeMs, hash: st.size < 1024 * 1024 ? hash(readFileSync(file)) : null }; }
  catch { return null; }
};
// Admission is conservative. The gate also compares its richer, actual execution identity.
// Use trees rather than SHAs so empty commits cannot reset a failure or retry budget.
export function deploymentIdentity({ repo, sha, root, base, branch = 'main', env }) {
  if (!env) {
    const config = join(root, 'control/deploy-worker.plist');
    if (existsSync(config)) {
      const r = spawnSync('/usr/bin/plutil', ['-extract', 'EnvironmentVariables', 'json', '-o', '-', config], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error('无法核实独立部署服务的环境配置');
      env = JSON.parse(r.stdout);
    } else env = process.env;
  }
  const tree = ref => ref ? git(repo, 'rev-parse', `${ref}^{tree}`) : null;
  const common = realpathSync(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const installed = join(root, 'control'), source = dirname(fileURLToPath(import.meta.url));
  const policy = ['deploy-failure-policy.mjs', 'deploy-when-idle.mjs', 'deploy-gui.sh', 'run-test-gate.mjs', 'test-plan.mjs', 'test-graph.mjs', 'flaky-quarantine.mjs', 'prepare-dependencies.mjs'].map(name => {
    const f = join(existsSync(join(installed, name)) ? installed : source, name);
    return hash(readFileSync(f));
  });
  const tools = ['node', 'npm', 'npx', 'git', 'python3'].map(name => {
    const f = (env.PATH ?? '').split(delimiter).map(p => join(p, name)).find(existsSync);
    return f ? [realpathSync(f), fileIdentity(f)] : null;
  });
  const flags = Object.fromEntries(Object.keys(env).filter(k => /^(PI_AGENT_(?:GATE_|TEST_MODE)|PLAYWRIGHT_|VITEST_|NODE_OPTIONS$|NODE_ENV$|CI$|TZ$)/.test(k)).sort().map(k => [k, env[k]]));
  let tip = null;
  try { tip = tree(`refs/heads/${branch}`); } catch { /* Detached fixture or a removed branch. */ }
  let quarantine = [];
  try { quarantine = JSON.parse(readFileSync(join(root, 'test-gates/quarantine.json'), 'utf8')).entries.filter(e => Date.parse(e.expiresAt) > Date.now()).map(e => e.file).sort(); } catch { /* No effective quarantine entries. */ }
  return hash(JSON.stringify({ common, tree: tree(sha), base: tree(base), tip, policy, tools, flags,
    node: process.version, platform: platform(), arch: arch(), release: release(),
    browsers: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].map(fileIdentity),
    quarantine }));
}
export const deploymentFailureFile = (root, key) => join(root, 'when-idle/failures', `${key}.json`);
export function blockedDeployment(root, key) {
  const record = readResult(deploymentFailureFile(root, key));
  return record?.status === 'failed' ? record : undefined;
}
export function unchangedFailure(record) {
  return Object.assign(new Error(`相同代码及检查输入已失败，未重复入队：${record.failures?.map(f => `${f.file || f.phase || record.phase}: ${f.test || f.kind}`).join('；') || record.phase}。请修复后再部署。日志：${record.logFile ?? '-'}`), { code: 'RT_DEPLOY_FAILED_UNCHANGED', failure: record });
}
