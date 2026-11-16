#!/usr/bin/env node
/** Lockfile-keyed dependency templates. No package install scripts, shared writable modules or hard links. */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, cpSync, existsSync, globSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 1;
const RECIPE = ['ci', '--include=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund'];
const READY = '.pi-deps-ready.json';
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part); };
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const envValue = (env, key) => Object.entries(env).find(([name]) => name.toLowerCase() === key)?.[1];
function optionalText(path) { return existsSync(path) ? readFileSync(path, 'utf8') : ''; }
function runtimeToolchain(env) {
  const agent = env.npm_config_user_agent?.match(/^npm\/([^ ]+)/)?.[1];
  return { node: process.version, abi: process.versions.modules, npm: agent ?? execFileSync('npm', ['--version'], { encoding: 'utf8', env }).trim(), platform: process.platform, arch: process.arch, os: release() };
}

export function dependencyIdentity({ repo = process.cwd(), toolchain, env = process.env } = {}) {
  repo = realpathSync(repo); toolchain ??= runtimeToolchain(env);
  const lockText = readFileSync(join(repo, 'package-lock.json'), 'utf8'), lock = JSON.parse(lockText);
  const pkg = json(join(repo, 'package.json'));
  const declared = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
  const manifests = new Set(['package.json']);
  for (const pattern of declared) {
    if (typeof pattern !== 'string' || isAbsolute(pattern) || pattern.split('/').includes('..')) throw new Error('Workspace paths must stay inside the repository');
    for (const path of globSync(pattern.replace(/\/$/, '') + '/package.json', { cwd: repo, exclude: ['**/node_modules/**'] })) manifests.add(path);
  }
  for (const [path, info] of Object.entries(lock.packages ?? {})) {
    if (!path || path.split('/').includes('node_modules')) continue;
    if (isAbsolute(path) || !inside(repo, resolve(repo, path))) throw new Error('Lockfile workspace path escapes repository');
    if (!info.link) manifests.add(join(path, 'package.json'));
  }
  // Directory/file dependencies with copied contents need a different snapshot contract. Workspace links are relocatable.
  for (const [path, info] of Object.entries(lock.packages ?? {})) {
    if (path.split('/').includes('node_modules') && !info.link && typeof info.resolved === 'string' && info.resolved.startsWith('file:')) throw new Error('Non-workspace file dependencies are not supported by the dependency template');
  }
  const files = [...manifests].sort().map(path => {
    const full = join(repo, path);
    if (!inside(repo, realpathSync(full))) throw new Error('Workspace manifest escapes repository');
    return { path, text: readFileSync(full, 'utf8') };
  });
  const workspaceRoots = files.filter(f => f.path !== 'package.json').map(f => dirname(f.path));
  const userConfig = envValue(env, 'npm_config_userconfig') || join(homedir(), '.npmrc');
  const globalConfig = envValue(env, 'npm_config_globalconfig') || join(dirname(dirname(process.execPath)), 'etc/npmrc');
  const projectConfig = optionalText(join(repo, '.npmrc'));
  const npmEnv = Object.fromEntries(Object.entries(env).filter(([name]) => /^npm_config_/i.test(name) && !/^npm_config_(user_agent|local_prefix|global_prefix|prefix|cache|logs_dir|userconfig|globalconfig|init_module|npm_version|node_gyp|noproxy|allow_scripts)$/i.test(name)).sort(([a], [b]) => a.localeCompare(b)));
  const user = optionalText(userConfig), global = optionalText(globalConfig);
  const references = new Set([...`${projectConfig}\n${user}\n${global}`.matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]));
  const referencedEnvironment = Object.fromEntries([...references].sort().map(name => [name, env[name] ?? null]));
  const configuration = hash(JSON.stringify({ projectConfig, user, global, npmEnv, referencedEnvironment, nodeEnv: env.NODE_ENV ?? null }));
  const key = hash(JSON.stringify({ version: VERSION, recipe: RECIPE, toolchain, lockText, files, configuration }));
  return { key, repo, files, lockText, projectConfig, workspaceRoots, toolchain };
}

function lock(file, action) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())) throw new Error('Dependency lock must be a regular file');
  const fd = openSync(file, 'a', 0o600);
  try {
    // The parent owns the open file description. Process death releases the lock without PID/lease recovery races.
    if (process.platform === 'darwin') execFileSync('/usr/bin/lockf', ['-s', '-t', '120', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
    else if (process.platform === 'linux') execFileSync('flock', ['-x', '-w', '120', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
    else throw new Error('Dependency template locking currently requires macOS or Linux');
    return action();
  } finally { closeSync(fd); }
}
function readReceipt(path) { try { return json(path); } catch { return undefined; } }
function validRoots(roots, input) {
  const allowed = new Set(['node_modules', ...input.workspaceRoots.map(path => join(path, 'node_modules'))]);
  return Array.isArray(roots) && roots.includes('node_modules') && roots.every(path => typeof path === 'string' && allowed.has(path));
}
function complete(root, receipt, input) {
  try {
    if (!receipt || receipt.version !== VERSION || receipt.key !== input.key || !validRoots(receipt.roots, input)) return false;
    for (const path of receipt.roots) { const stat = lstatSync(join(root, path)); if (stat.isSymbolicLink() || !stat.isDirectory()) return false; }
    const file = join(root, 'node_modules/.package-lock.json');
    if (hash(readFileSync(file)) !== receipt.installedLock) return false;
    for (const [path, pkg] of Object.entries(json(file).packages ?? {})) {
      if (pkg.link || !path.split('/').includes('node_modules')) continue;
      if (isAbsolute(path) || !inside(root, resolve(root, path)) || !statSync(join(root, path, 'package.json')).isFile()) return false;
    }
    return true;
  } catch { return false; }
}
function normalizeLinks(root, path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(path), resolved = resolve(dirname(path), target);
    if (!inside(root, resolved)) throw new Error('Installed dependency link escapes template project');
    if (isAbsolute(target)) { rmSync(path); symlinkSync(relative(dirname(path), resolved), path, process.platform === 'win32' ? 'junction' : undefined); }
  } else if (stat.isDirectory()) for (const name of readdirSync(path)) normalizeLinks(root, join(path, name));
}
function defaultInstall(stage, env, log) {
  const childEnv = { ...env };
  for (const name of Object.keys(childEnv)) if (/^npm_config_(local_prefix|prefix|workspace|workspaces|global|location|allow_scripts)$/i.test(name) || /^(npm_lifecycle_|npm_package_|INIT_CWD)/.test(name)) delete childEnv[name];
  // Always prefer the shared npm download cache. Only a genuine cold cache needs the registry.
  // 外层是 `npm run --silent` 时 npm_config_loglevel=silent 会把下面这条 ENOTCACHED 一起吞掉，
  // 探测器就看不见「缓存未命中」而直接硬失败：这里只给这次探测抬高日志级别（不动 RECIPE，避免换模板 key）。
  const probeEnv = { ...childEnv, npm_config_loglevel: 'error' };
  const offline = spawnSync('npm', [...RECIPE, '--offline'], { cwd: stage, env: probeEnv, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (offline.status === 0) return;
  if (!/ENOTCACHED|cache mode is 'only-if-cached'/.test(`${offline.stdout}\n${offline.stderr}`)) throw new Error(`Dependency installation failed: ${String(offline.stderr || offline.error?.message || offline.status).slice(-2000)}`);
  if (env.PI_AGENT_DEPS_OFFLINE === '1') throw new Error('Dependency download cache is incomplete and PI_AGENT_DEPS_OFFLINE=1');
  log('依赖下载缓存未命中，按锁文件获取缺失包');
  const online = spawnSync('npm', RECIPE, { cwd: stage, env: childEnv, stdio: 'inherit' });
  if (online.status !== 0) throw new Error(`Dependency installation failed (${online.status ?? online.error?.message})`);
}
function buildTemplate(input, cacheDir, install, env, log) {
  const target = join(cacheDir, input.key), existing = readReceipt(join(target, 'template.json'));
  if (complete(join(target, 'payload'), existing, input)) return { target, receipt: existing, built: false };
  const temp = join(cacheDir, `.building-${input.key}-${randomUUID()}`), project = join(temp, 'project'), payload = join(temp, 'payload');
  mkdirSync(project, { recursive: true, mode: 0o700 });
  try {
    for (const file of input.files) {
      const path = join(project, file.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, file.text);
      // npm creates workspace bin links only when their declared targets exist during installation.
      const pkg = JSON.parse(file.text), bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {});
      for (const bin of bins) {
        if (typeof bin !== 'string' || isAbsolute(bin) || !inside(dirname(path), resolve(dirname(path), bin))) throw new Error('Workspace bin path escapes package');
        const placeholder = resolve(dirname(path), bin); mkdirSync(dirname(placeholder), { recursive: true }); if (!existsSync(placeholder)) writeFileSync(placeholder, '#!/usr/bin/env node\n', { mode: 0o755 });
      }
    }
    writeFileSync(join(project, 'package-lock.json'), input.lockText);
    if (input.projectConfig) writeFileSync(join(project, '.npmrc'), input.projectConfig, { mode: 0o600 });
    log('构建依赖模板（按锁文件，禁用安装脚本）');
    (install ?? (stage => defaultInstall(stage, env, log)))(project);
    const roots = ['node_modules', ...input.workspaceRoots.map(path => join(path, 'node_modules'))].filter(path => existsSync(join(project, path)));
    for (const path of roots) {
      normalizeLinks(project, join(project, path));
      mkdirSync(dirname(join(payload, path)), { recursive: true }); renameSync(join(project, path), join(payload, path));
    }
    const receipt = { version: VERSION, key: input.key, roots, installedLock: hash(readFileSync(join(payload, 'node_modules/.package-lock.json'))) };
    if (!complete(payload, receipt, input)) throw new Error('Dependency template installation is incomplete');
    rmSync(project, { recursive: true, force: true });
    writeFileSync(join(temp, 'template.json'), JSON.stringify(receipt));
    rmSync(target, { recursive: true, force: true }); renameSync(temp, target);
    return { target, receipt, built: true };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
function copyDependencyTree(source, destination, options) {
  // Native traversal avoids Node's per-file JS metadata overhead on large trees.
  // APFS clones and GNU reflinks share disk extents, never writable file inodes.
  const command = process.platform === 'darwin' ? '/bin/cp' : 'cp';
  const args = process.platform === 'darwin' ? ['-cRPp', source, destination] : ['--reflink=auto', '-a', source, destination];
  const copied = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (copied.status === 0) return;
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, options);
}
function materialize(input, template, copyTree, verifyInputs) {
  const repo = input.repo, previous = readReceipt(join(repo, READY));
  const roots = new Set(['node_modules', ...input.workspaceRoots.map(path => join(path, 'node_modules'))]);
  // Removed workspaces can still have ignored modules left behind from an earlier lockfile.
  for (const path of previous?.roots ?? []) {
    if (typeof path === 'string' && path.endsWith('/node_modules') && !isAbsolute(path) && inside(repo, resolve(repo, path))) roots.add(path);
  }
  for (const path of roots) {
    const parent = dirname(join(repo, path));
    if (existsSync(parent) && !inside(repo, realpathSync(parent))) throw new Error('Dependency destination escapes worktree');
  }
  const stage = join(repo, `.pi-deps-copy-${randomUUID()}`); mkdirSync(stage);
  try {
    for (const path of template.receipt.roots) {
      mkdirSync(dirname(join(stage, path)), { recursive: true });
      copyTree(join(template.target, 'payload', path), join(stage, path), { recursive: true, dereference: false, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    }
    if (!complete(stage, template.receipt, input)) throw new Error('Copied dependency template is incomplete');
    for (const path of roots) rmSync(join(repo, path), { recursive: true, force: true });
    for (const path of template.receipt.roots) { mkdirSync(dirname(join(repo, path)), { recursive: true }); renameSync(join(stage, path), join(repo, path)); }
    verifyInputs();
    const marker = join(stage, 'ready.json'); writeFileSync(marker, JSON.stringify(template.receipt)); renameSync(marker, join(repo, READY));
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export function prepareDependencies({ repo = process.cwd(), cacheDir = process.env.PI_AGENT_DEPS_CACHE || join(homedir(), '.cache/pi-agent/dependency-templates'), toolchain, env = process.env, install, copyTree = copyDependencyTree, log = console.log } = {}) {
  let input = dependencyIdentity({ repo, toolchain, env });
  toolchain ??= input.toolchain;
  const local = readReceipt(join(input.repo, READY));
  if (complete(input.repo, local, input)) return { state: 'ready', key: input.key };
  cacheDir = resolve(cacheDir);
  if (inside(input.repo, cacheDir) || inside(cacheDir, input.repo)) throw new Error('Dependency template cache must be separate from the worktree');
  return lock(join(input.repo, '.pi-deps.mutex'), () => {
    input = dependencyIdentity({ repo: input.repo, toolchain, env });
    if (complete(input.repo, readReceipt(join(input.repo, READY)), input)) return { state: 'ready', key: input.key };
    const verifyInputs = () => {
      if (dependencyIdentity({ repo: input.repo, toolchain, env }).key !== input.key) throw new Error('Dependency inputs changed during preparation; retry');
    };
    const use = template => {
      verifyInputs();
      materialize(input, template, copyTree, verifyInputs);
      log(template.built ? '依赖模板已构建，已生成独立副本' : '复用依赖模板，已生成独立副本');
      return { state: template.built ? 'built' : 'restored', key: input.key, templateDir: template.target };
    };
    // Published templates are immutable: warm readers need no cache writes or shared builder lock.
    const target = join(cacheDir, input.key), receipt = readReceipt(join(target, 'template.json'));
    if (complete(join(target, 'payload'), receipt, input)) return use({ target, receipt, built: false });
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    return lock(join(cacheDir, `${input.key}.mutex`), () => use(buildTemplate(input, cacheDir, install, env, log)));
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
    prepareDependencies({ repo: value('--repo') ?? process.cwd(), ...(value('--cache-dir') ? { cacheDir: value('--cache-dir') } : {}) });
  } catch (error) { console.error(`依赖准备失败：${error.message}`); process.exitCode = 1; }
}
