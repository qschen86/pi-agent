import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validatePayload } from '../apps/homebrew/src/payload.mjs';
import { renderFormula } from '../apps/homebrew/src/formula.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (command, args) => execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
const blocked = new Set(['node_modules', 'dist', '.git', '.pi-agent', '.diagnostics', 'evidence', '.release', '.platform-browser']);
// 导出模块只在维护者仓库里有（公开源码包不带它）：有就按清单导出——私有 / 未发布应用换空桩、index.html 裁剪、
// 域名与本机用户名匿名化，并在写出前跑一遍公开前扫描，命中就中止；没有说明源码已经是导出后的，沿用整目录拷贝。
const exporterPath = new URL('./lib/public-export.mjs', import.meta.url);
const exporter = existsSync(exporterPath) ? await import(exporterPath.href) : null;
function copySourcesFromManifest(destination) {
  const listing = exporter.publicSourceFiles(repo);
  const { findings } = exporter.scanPublicSource(repo);
  if (findings.length) {
    const lines = findings.slice(0, 20).map(f => `  ${f.file}:${f.line} [${f.label}] ${f.text}`);
    throw Error(`公开前扫描发现 ${findings.length} 处个人信息，已中止发行：\n${lines.join('\n')}`);
  }
  for (const [kind, files] of [['copy', listing.copy], ['stub', listing.stub], ['html', listing.html]]) {
    for (const file of files) {
      const source = join(repo, file), stat = lstatSync(source);
      if (stat.isSymbolicLink() || !stat.isFile()) throw Error('公开源码不得含符号链接或特殊文件');
      mkdirSync(dirname(join(destination, file)), { recursive: true });
      if (kind === 'copy' && !exporter.TEXT_FILE.test(file)) cpSync(source, join(destination, file));
      else writeFileSync(join(destination, file), exporter.publicFileContent(repo, file, kind));
    }
  }
  return listing;
}
export function copySources(destination) {
  if (exporter) {
    copySourcesFromManifest(destination);
    cpSync(join(repo, 'apps/homebrew/README.md'), join(destination, 'README.md'));
    return;
  }
  const copy = path => cpSync(join(repo, path), join(destination, path), { recursive: true, dereference: false, filter: file => {
    const parts = relative(repo, file).split(sep);
    if (parts.some(part => blocked.has(part) || part.startsWith('.env') || part === '.DS_Store' || part === 'ACCEPTANCE.md')) return false;
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw Error('公开源码不得含符号链接或特殊文件');
    return !/\.(?:dmg|pem|key|p12|keystore|jks|log)$/i.test(file);
  } });
  for (const path of ['LICENSE', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json', 'apps/homebrew', 'apps/web/src', 'apps/web/public', 'packages']) copy(path);
  // Keep workspace manifests so npm ci can reproduce the root lockfile.
  for (const name of readdirSync(join(repo, 'apps'))) if (existsSync(join(repo, 'apps', name, 'package.json'))) copy(`apps/${name}/package.json`);
  for (const path of ['scripts/build-homebrew-release.mjs', 'scripts/build-homebrew-payload.mjs', 'scripts/check-homebrew-payload.mjs', 'scripts/prepare-homebrew-image-sources.py', 'scripts/runtime-record.mjs', 'scripts/prepare-dependencies.mjs']) copy(path);
  for (const path of ['scripts/deploy-when-idle.mjs', 'scripts/deploy-when-idle.d.mts', 'scripts/deployment-actions.mjs', 'scripts/deployment-actions.d.mts', 'scripts/lib/public-transform.mjs']) {
    if (existsSync(join(repo, path))) copy(path);
  }
  cpSync(join(repo, 'apps/homebrew/README.md'), join(destination, 'README.md'));
}
export function buildRelease({ payload, imageSources, output, repository }) {
  const manifest = validatePayload(payload);
  renderFormula({ repository, version: manifest.version, sha256: '0'.repeat(64) });
  output = resolve(output);
  if (existsSync(output)) throw Error('发行输出目录已存在，拒绝覆盖');
  if (!imageSources) throw Error('需要图像库对应源码 --image-sources');
  for (const directory of [payload, imageSources, join(repo, 'apps'), join(repo, 'packages')]) {
    const rel = relative(resolve(directory), output);
    if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..')) throw Error('发行输出目录必须与载荷、源码及对应源码分离');
  }
  const receipt = JSON.parse(readFileSync(join(imageSources, 'source-receipt.json'), 'utf8'));
  const bundledReceipt = JSON.parse(readFileSync(join(payload, 'licenses/image-library-source-receipt.json'), 'utf8'));
  if (!receipt.complete || JSON.stringify(receipt) !== JSON.stringify(bundledReceipt)) throw Error('对应源码必须与载荷收据一致');
  for (const item of receipt.sources) {
    if (basename(item.file) !== item.file || digest(join(imageSources, item.file)) !== item.sha256) throw Error('对应源码校验失败');
  }
  mkdirSync(output, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), 'pi-homebrew-release-'));
  try {
    const prefix = `pi-agent-${manifest.version}`, archive = `${prefix}-macos-arm64.tar.gz`;
    run('/usr/bin/tar', ['-czf', join(output, archive), '-C', resolve(payload), '.']);
    const source = join(stage, `${prefix}-source`); mkdirSync(source); copySources(source);
    run('/usr/bin/tar', ['-czf', join(output, `${prefix}-source.tar.gz`), '-C', stage, `${prefix}-source`]);
    run('/usr/bin/tar', ['-czf', join(output, `${prefix}-image-library-sources.tar.gz`), '-C', resolve(imageSources), '.']);
    writeFileSync(join(output, 'pi-agent.rb'), renderFormula({ repository, version: manifest.version, sha256: digest(join(output, archive)) }));
    cpSync(join(repo, 'apps/homebrew/README.md'), join(output, 'INSTALL.md'));
    const files = readdirSync(output).sort().map(file => ({ file, sha256: digest(join(output, file)) }));
    writeFileSync(join(output, 'SHA256SUMS'), files.map(item => `${item.sha256}  ${item.file}\n`).join(''));
    return { version: manifest.version, repository, files, published: false };
  } catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
  finally { rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const allowed = new Set(['payload', 'pi-source', 'npm-source', 'image-sources', 'output', 'repository']);
    for (let i = 2; i < process.argv.length; i += 2) {
      const name = process.argv[i].slice(2), value = process.argv[i + 1];
      if (!process.argv[i].startsWith('--') || !allowed.has(name) || !value || value.startsWith('--') || options[name]) throw Error('发行参数无效');
      options[name] = value;
    }
    if (!options.output || !options.repository) throw Error('必须提供 --output 和已确定的 --repository owner/repo');
    let payload = options.payload, temporary;
    try {
      if (!payload) {
        if (!options['pi-source'] || !options['npm-source'] || !options['image-sources']) throw Error('构建需要 --pi-source、--npm-source 和 --image-sources');
        temporary = mkdtempSync(join(tmpdir(), 'pi-homebrew-build-')); payload = join(temporary, 'payload');
        const result = run(process.execPath, [join(repo, 'scripts/build-homebrew-payload.mjs'), '--output', payload, '--pi-source', options['pi-source'], '--npm-source', options['npm-source'], '--image-sources', options['image-sources']]);
        process.stdout.write(result);
      }
      console.log(JSON.stringify(buildRelease({ payload, imageSources: options['image-sources'], output: options.output, repository: options.repository }), null, 2));
    } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
