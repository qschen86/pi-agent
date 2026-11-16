import { build } from 'esbuild';
import ts from 'typescript';
import { createRequire, isBuiltin } from 'node:module';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CORE_COMPONENTS } from '../apps/homebrew/src/initialization.mjs';
import { validatePayload } from '../apps/homebrew/src/payload.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const value = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const output = resolve(value('--output') ?? join(repo, 'dist/homebrew-payload'));
const piSource = value('--pi-source');
const npmSource = value('--npm-source');
const imageSources = value('--image-sources');
if (!piSource) throw Error('必须显式提供经过验证的 Pi npm 包目录 --pi-source');
if (!npmSource) throw Error('必须显式提供 Node 24 配套的 npm 包目录 --npm-source');
const inputs = JSON.parse(readFileSync(join(repo, 'apps/homebrew/build-inputs.json'), 'utf8'));
for (const [kind, source] of [['pi', piSource], ['npm', npmSource]]) {
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (pkg.name !== inputs[kind].name || pkg.version !== inputs[kind].version) throw Error(`构建输入版本不符：${kind}`);
}
if (existsSync(output)) throw Error('载荷输出目录已经存在，请使用新的目录');
const requireFromRepo = createRequire(join(repo, 'package.json'));
const omitted = /[/\\]apps[/\\]web[/\\]src[/\\](?:communications[^/\\]*|stock-ledger[^/\\]*|ledger-chat|challenge[^/\\]*|wrong-book[^/\\]*|game-companion|share-routes|artifact-shares)\.ts$/;
const stubExports = path => {
  const ast = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = [];
  for (const statement of ast.statements) if (statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
    if (ts.isClassDeclaration(statement) && statement.name) names.push(`export class ${statement.name.text} {}`);
    else if (ts.isFunctionDeclaration(statement) && statement.name) names.push(`export function ${statement.name.text}(){return undefined}`);
    else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.push(`export const ${declaration.name.text} = undefined;`);
  }
  return names.join('\n');
};
const plugin = { name: 'core-edition', setup(builder) {
  builder.onResolve({ filter: /^ajv\/dist\/2020$/ }, () => ({ path: 'ajv/dist/2020.js', external: true }));
  builder.onResolve({ filter: /^@anthropic-ai\/claude-agent-sdk$/ }, () => ({ path: 'optional-claude', namespace: 'core-optional' }));
  builder.onLoad({ filter: /.*/, namespace: 'core-optional' }, () => ({ contents: 'export function query(){throw Error("Claude Code is an optional component")}; export const listSessions=async()=>[]; export const getSessionMessages=async()=>[]; export const getSessionInfo=async()=>null; export const resolveSettings=async()=>({});', loader: 'js' }));
  builder.onLoad({ filter: /\.ts$/ }, args => {
    if (omitted.test(args.path)) return { contents: stubExports(args.path), loader: 'ts' };
    let source = readFileSync(args.path, 'utf8');
    if (args.path.endsWith('/apps/web/src/platform-scheduled-tasks.ts')) source = source.replace('for (const task of defaultPlatformScheduledTasks()) merged.set(task.id, task);', '// Standalone edition displays only jobs registered by this running instance.');
    if (args.path.endsWith('/apps/web/src/artifacts.ts')) source = 'export const ARTIFACT_CSP = "default-src none"; export class ArtifactLibrary {catalog(){return {schema:1,categories:[],items:[]}}version(){return null}versionManifest(){return null}read(){return null}}';
    // Preserve every resource's original directory without embedding the build machine's absolute path.
    const resource = '../layout/' + relative(repo, args.path).split(sep).join('/');
    source = source.replace(/import\.meta\.url/g, `new URL(${JSON.stringify(resource)}, import.meta.url).href`);
    return { contents: source, loader: 'ts', resolveDir: dirname(args.path) };
  });
} };

const copied = new Map();
function packageRoot(name, from) {
  const req = createRequire(join(from, 'package.json'));
  for (const base of req.resolve.paths(name) ?? []) { const candidate = join(base, name); if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate); }
  let at;
  try { at = dirname(req.resolve(`${name}/package.json`)); }
  catch { at = dirname(req.resolve(name)); }
  while (true) { if (existsSync(join(at, 'package.json')) && JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')).name === name) return realpathSync(at); const next = dirname(at); if (next === at) throw Error(`无法定位依赖 ${name}`); at = next; }
}
function copyDependency(source, parentDestination = output) {
  const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  if (pkg.os && !pkg.os.includes('darwin') || pkg.cpu && !pkg.cpu.includes('arm64')) return;
  const identity = `${pkg.name}@${pkg.version}`;
  try { const reachable = packageRoot(pkg.name, parentDestination); if (reachable.startsWith(realpathSync(output) + sep) && JSON.parse(readFileSync(join(reachable, 'package.json'), 'utf8')).version === pkg.version) return; } catch {}
  let destination = join(output, 'node_modules', pkg.name);
  if (existsSync(destination)) destination = join(parentDestination, 'node_modules', pkg.name);
  if (existsSync(destination)) throw Error(`依赖版本冲突：${pkg.name}`);
  copied.set(destination, identity); mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true, filter: path => {
    const rel = relative(source, path); return !rel.split(sep).some(part => ['node_modules', 'test', 'tests', '__tests__', 'bench', 'benchmark', 'benchmarks', 'examples', '.git', '.github', 'evidence'].includes(part)) && !/\.map$/.test(rel) && (!/\.md$/.test(rel) || /(?:^|\/)(?:LICEN[CS]E|NOTICE|COPYING|README)/i.test(rel)) && !/(^|\/)(?:auth|service-account|google-services)\.json$/.test(rel);
  } });
  for (const [name] of Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    try { copyDependency(packageRoot(name, source), destination); }
    catch (error) { if (!Object.hasOwn(pkg.optionalDependencies ?? {}, name)) throw error; }
  }
}

try {
  mkdirSync(join(output, 'bundle'), { recursive: true });
  const result = await build({ entryPoints: [join(repo, 'apps/homebrew/src/core-web.ts')], outfile: join(output, 'bundle/core.mjs'), bundle: true, platform: 'node', format: 'esm', banner: { js: 'import { createRequire as __coreRequire } from \"node:module\"; const require = __coreRequire(import.meta.url);' }, target: 'node24', packages: 'external', plugins: [plugin], external: [], metafile: true,
    // Workspace packages must be compiled; external npm dependencies are copied below.
    alias: Object.fromEntries(readdirSync(join(repo, 'packages')).filter(name => existsSync(join(repo, 'packages', name, 'package.json'))).map(name => [JSON.parse(readFileSync(join(repo, 'packages', name, 'package.json'), 'utf8')).name, join(repo, 'packages', name, 'src/index.ts')]))
  });
  const external = new Set(Object.values(result.metafile.outputs).flatMap(o => o.imports.filter(i => i.external && !isBuiltin(i.path) && !i.path.startsWith('.')).map(i => i.path.startsWith('@') ? i.path.split('/').slice(0, 2).join('/') : i.path.split('/')[0])));
  external.add('tsx');
  for (const name of external) copyDependency(packageRoot(name, repo));
  copyDependency(realpathSync(piSource));
  // npm ships a complete bundled dependency tree. Preserve that tree instead of
  // recursively resolving it as ordinary dependencies (which duplicates nested versions).
  const npmDestination = join(output, 'node_modules/npm');
  if (JSON.parse(readFileSync(join(npmSource, 'package.json'), 'utf8')).name !== 'npm') throw Error('安装工具来源不是 npm 包');
  cpSync(realpathSync(npmSource), npmDestination, { recursive: true, dereference: true, filter: path => {
    const rel = relative(realpathSync(npmSource), path);
    return !rel.split(sep).some(part => ['test', 'tests', '__tests__', '.git', '.github', 'docs', 'man'].includes(part)) && !/\.map$/.test(rel);
  } });
  function recordNpmTree(directory) {
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    copied.set(directory, `${pkg.name}@${pkg.version}`);
    const nested = join(directory, 'node_modules'); if (!existsSync(nested)) return;
    for (const name of readdirSync(nested)) {
      if (name.startsWith('.')) continue;
      const path = join(nested, name);
      if (name.startsWith('@')) { for (const child of readdirSync(path)) if (existsSync(join(path, child, 'package.json'))) recordNpmTree(join(path, child)); }
      else if (existsSync(join(path, 'package.json'))) recordNpmTree(path);
    }
  }
  recordNpmTree(npmDestination);
  for (const name of ['pi-runtime', 'adapter-pi', 'domain', 'runtime-contracts', 'runtime-memory', 'runtime-sessions', 'web-research', 'schemas']) {
    const source = join(repo, 'packages', name); const destination = join(output, 'layout/packages', name);
    for (const dir of ['src', 'schemas', 'config']) if (existsSync(join(source, dir))) cpSync(join(source, dir), join(destination, dir), { recursive: true, filter: path => !/\.(?:map|md)$/.test(path) });
  }
  // Runtime resource sources use direct relative workspace imports, never global workspace links.
  const rewrite = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) rewrite(path); else if (/\.[cm]?[jt]s$/.test(entry.name)) { let source = readFileSync(path, 'utf8'); source = source.replace(/(["'])@pi-agent\/([a-z-]+)\1/g, (_all, quote, name) => { let rel = relative(dirname(path), join(output, 'layout/packages', name, 'src/index.js')).split(sep).join('/'); if (!rel.startsWith('.')) rel = './' + rel; return quote + rel + quote; }); writeFileSync(path, source); } } };
  rewrite(join(output, 'layout/packages'));
  // The installed runtime lives inside the user's Applications folder, which Seatbelt otherwise
  // treats as private HOME content. Grant the shipped code and Node executable read access only.
  const boundaryFile = join(output, 'layout/packages/pi-runtime/src/pi-boundary.ts');
  let boundarySource = readFileSync(boundaryFile, 'utf8');
  for (const field of ['runtimeReadable: [root,', 'commandReadRoots: [root,']) {
    if (!boundarySource.includes(field)) throw Error('Pi 安装代码的只读边界装配点已变化，请更新打包适配');
    boundarySource = boundarySource.replace(field, field.replace('[root,', '[fileURLToPath(new URL("../../../../", import.meta.url)), process.execPath, root,'));
  }
  writeFileSync(boundaryFile, boundarySource);
  mkdirSync(join(output, 'layout/scripts'), { recursive: true });
  cpSync(join(repo, 'scripts/runtime-record.mjs'), join(output, 'layout/scripts/runtime-record.mjs'));
  for (const name of external) if (name.startsWith('@pi-agent/')) throw Error(`未打包的工作区依赖：${name}`);
  cpSync(join(repo, 'apps/homebrew/src'), join(output, 'apps/homebrew/src'), { recursive: true, filter: path => !path.endsWith('/core-web.ts') });
  cpSync(join(repo, 'apps/homebrew/web'), join(output, 'apps/homebrew/web'), { recursive: true });
  cpSync(join(repo, 'apps/homebrew/runtime-manifests'), join(output, 'apps/homebrew/runtime-manifests'), { recursive: true });
  const pub = join(output, 'layout/apps/web/public'); mkdirSync(pub, { recursive: true });
  const excludedAsset = /^(?:ledger|communications(?:-ai)?|web-x|android-shell|native-update|recent-photos)(?:\.|$)/;
  cpSync(join(repo, 'apps/web/public'), pub, { recursive: true, filter: path => { const rel = relative(join(repo, 'apps/web/public'), path); return !rel.split(sep).some(p => p.startsWith('.')) && !excludedAsset.test(rel) && !/\.map$/.test(rel) && (!/\.md$/.test(rel) || /(?:^|\/)(?:LICEN[CS]E|NOTICE|COPYING|README)/i.test(rel)); } });
  let index = readFileSync(join(pub, 'index.html'), 'utf8');
  index = index.replace(/<button\b[^>]*data-view="(?:ledger|communications|web-x|resources)"[\s\S]*?<\/button>/g, '');
  index = index.split('\n').filter(line => !/(?:src|href)="\/(?:communications[^"?]*|ledger|web-x|android-shell|native-update|recent-photos)\.(?:js|css)/.test(line)).join('\n');
  writeFileSync(join(pub, 'index.html'), index);
  let runtimeJs = readFileSync(join(pub, 'runtime.js'), 'utf8');
  runtimeJs = runtimeJs.replace('lastKind : "codex"', 'lastKind : "pi"').replace('worktree: true };', 'worktree: false };').replace('ui.rt.workspace = saved.length <= 8192 ? saved : "";', 'ui.rt.workspace = saved && saved.length <= 8192 ? saved : (ui.rt.settings?.workspaceRoots?.[0] || "");');
  writeFileSync(join(pub, 'runtime.js'), runtimeJs);
  const artifactsUi = join(pub, 'artifacts.js');
  writeFileSync(artifactsUi, readFileSync(artifactsUi, 'utf8').replace('if (!(data.categories || []).length && !(data.items || []).length) return [];', '// Keep the user collection and its empty-state guidance visible in the core edition.'));
  // Recompute query hashes after edition-specific asset transformations.
  index = index.replace(/((?:src|href)="\/([^"?]+))\?v=[a-f0-9]+/g, (all, prefix, asset) => {
    const file = join(pub, asset);
    return existsSync(file) && lstatSync(file).isFile() ? prefix + '?v=' + createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12) : all;
  });
  writeFileSync(join(pub, 'index.html'), index);
  mkdirSync(join(output, 'bin'));
  const piPkg = JSON.parse(readFileSync(join(piSource, 'package.json'), 'utf8'));
  const bin = typeof piPkg.bin === 'string' ? piPkg.bin : piPkg.bin.pi;
  const ai = await import(new URL('file://' + join(packageRoot('@earendil-works/pi-ai', piSource), 'dist/providers/deepseek.models.js')));
  const supportedModels = Object.values(ai.DEEPSEEK_MODELS).map(model => model.id);
  if (!supportedModels.length) throw Error('Pi 没有可用的 DeepSeek 模型目录');
  writeFileSync(join(output, 'runtime-locations.json'), JSON.stringify({ pi: `node_modules/${piPkg.name}/${bin}`, supportedModels }));
  writeFileSync(join(output, 'bin/node'), '#!/bin/sh\nset -eu\nroot="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "@HOMEBREW_NODE@" "$@"\n', { mode: 0o755 });
  writeFileSync(join(output, 'bin/pi'), `#!/bin/sh\nset -eu\nroot="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$root/bin/node" "$root/node_modules/${piPkg.name}/${bin}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(output, 'bin/pi-runtime'), '#!/bin/sh\nset -eu\nroot="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$root/bin/node" --import "$root/node_modules/tsx/dist/loader.mjs" "$root/layout/packages/pi-runtime/src/cli.ts" "$@"\n', { mode: 0o755 });
  writeFileSync(join(output, 'main.mjs'), 'import { main } from "./apps/homebrew/src/cli.mjs";\nmain().catch(error => { console.error(error.message); process.exitCode = 1; });\n');
  writeFileSync(join(output, 'package.json'), JSON.stringify({ name: 'pi-agent-core-distribution', version: JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version, license: 'MIT', type: 'module', private: true }));
  cpSync(join(repo, 'LICENSE'), join(output, 'LICENSE'));
  cpSync(join(repo, 'apps/homebrew/build-inputs.json'), join(output, 'build-inputs.json'));
  cpSync(join(repo, 'apps/homebrew/README.md'), join(output, 'INSTALL.md'));
  cpSync(join(repo, 'apps/homebrew/licenses'), join(output, 'licenses'), { recursive: true });
  if (!imageSources) throw Error('请先准备图像库对应源码，提供 --image-sources');
  const sourceReceipt = JSON.parse(readFileSync(join(imageSources, 'source-receipt.json'), 'utf8'));
  if (!sourceReceipt.complete || sourceReceipt.sources.length !== 33) throw Error('图像库对应源码不完整');
  const sourceSpec = JSON.parse(readFileSync(join(repo, 'apps/homebrew/licenses/image-library-sources.json'), 'utf8'));
  if (new Set(sourceReceipt.sources.map(item => item.file)).size !== sourceSpec.sources.length || sourceReceipt.sources.some(item => !sourceSpec.sources.some(expected => expected.file === item.file && expected.url === item.url))) throw Error('对应源码来源与固定配方不符');
  const libraryVersions = JSON.parse(readFileSync(join(output, 'node_modules/@img/sharp-libvips-darwin-arm64/versions.json'), 'utf8'));
  const pinnedVersions = Object.fromEntries(readFileSync(join(repo, 'apps/homebrew/licenses/sharp-libvips-1.2.4-versions.properties'), 'utf8').trim().split('\n').map(line => line.replace(/^VERSION_/, '').toLowerCase().split('=')));
  for (const [name, version] of Object.entries(libraryVersions)) if (pinnedVersions[name === 'highway' ? 'hwy' : name.replaceAll('-', '_')] !== version) throw Error(`图像库源码版本不匹配：${name}`);
  for (const item of sourceReceipt.sources) {
    if (createHash('sha256').update(readFileSync(join(imageSources, item.file))).digest('hex') !== item.sha256) throw Error('对应源码校验失败');
  }
  cpSync(join(imageSources, 'notices'), join(output, 'licenses/image-library'), { recursive: true });
  cpSync(join(imageSources, 'source-receipt.json'), join(output, 'licenses/image-library-source-receipt.json'));
  const supplemental = name => name.startsWith('@earendil-works/pi-') ? 'Pi-1.2.0-LICENSE' : name.startsWith('@aws-sdk/') ? 'aws-sdk-LICENSE' : ({ http_ece: 'http_ece-LICENSE', standardwebhooks: 'standardwebhooks-LICENSE', 'proxy-agent-negotiate': 'proxy-agent-negotiate-LICENSE', 'data-uri-to-buffer': 'data-uri-to-buffer-LICENSE', '@img/sharp-libvips-darwin-arm64': 'LGPL-3.0.txt', 'spdx-exceptions': 'spdx-exceptions-LICENSE', 'spdx-license-ids': 'spdx-license-ids-LICENSE', '@npmcli/agent': 'npmcli-agent-LICENSE', '@sigstore/verify': 'sigstore-verify-LICENSE' })[name];
  const inventory = [];
  for (const destination of copied.keys()) {
    const pkg = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
    const licenses = readdirSync(destination).filter(name => /^(?:LICEN[CS]E|COPYING|NOTICE)/i.test(name) && lstatSync(join(destination, name)).isFile()).map(name => relative(output, join(destination, name)));
    if (!licenses.length && pkg.name === '@esbuild/darwin-arm64') {
      cpSync(join(packageRoot('esbuild', repo), 'LICENSE.md'), join(destination, 'LICENSE.md'));
      licenses.push(relative(output, join(destination, 'LICENSE.md')));
    }
    if (!licenses.length && supplemental(pkg.name)) licenses.push('licenses/' + supplemental(pkg.name));
    if (!licenses.length) throw Error(`依赖缺少许可正文：${pkg.name}@${pkg.version}`);
    inventory.push({ name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository, path: relative(output, destination), licenseFiles: licenses });
  }
  inventory.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(join(output, 'third-party-packages.json'), JSON.stringify({ schema: 1, packages: inventory }, null, 2) + '\n');
  writeFileSync(join(output, 'THIRD-PARTY-NOTICES.md'), '# Third-party notices\n\npi-agent 自有代码采用 MIT。第三方代码保持各自许可，MIT 不覆盖整个安装包。\n\nNode 由 Homebrew 单独提供，许可随其配方分发。npm 依赖版本、来源和许可路径见 third-party-packages.json；完整补充许可及上游来源见 licenses/。网页图标及 html-to-image 的原始声明保留在 layout/apps/web/public/。\n\n图像共享库含 LGPLv3 / MPL2.0 组件。版本见 licenses/sharp-libvips-1.2.4-versions.properties；各库版权及许可见 licenses/image-library/。未修改的对应源码、补丁和构建配方必须与发行包在同一 GitHub Release 提供，附件名 pi-agent-VERSION-image-library-sources.tar.gz。核对各源码 SHA256 见 licenses/image-library-source-receipt.json。\n\n允许按 LGPL 条款修改、替换和调试相关库，不对这些行为施加额外限制。库位于 node_modules/@img/sharp-libvips-darwin-arm64/lib/；修改后需重新构建。构建配方见 licenses/sharp-libvips-build/。\n');
  const files = {};
  const walk = dir => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (lstatSync(path).isDirectory()) walk(path); else files[relative(output, path).split(sep).join('/')] = createHash('sha256').update(readFileSync(path)).digest('hex'); } };
  walk(output);
  const serialized = JSON.stringify({ schema: 1, edition: 'mac-local-core', version: JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version, arch: 'arm64', entry: 'main.mjs', components: CORE_COMPONENTS, files });
  writeFileSync(join(output, 'distribution.json'), serialized);
  console.log(JSON.stringify({ manifestBytes: Buffer.byteLength(serialized), files: Object.keys(files).length, packages: copied.size }));
  validatePayload(output);
  console.log(JSON.stringify({ output, files: Object.keys(files).length, packages: copied.size, optionalApplications: 'excluded' }));
} catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
