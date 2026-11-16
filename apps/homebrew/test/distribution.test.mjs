import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validatePayload } from '../src/payload.mjs';
import { CORE_COMPONENTS } from '../src/initialization.mjs';
import { renderFormula } from '../src/formula.mjs';

function payload(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-brew-payload-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const text = 'console.log("test");\n'; writeFileSync(join(dir, 'main.mjs'), text);
  const manifest = { schema: 1, edition: 'mac-local-core', arch: 'arm64', entry: 'main.mjs', version: '0.1.0', components: CORE_COMPONENTS,
    files: { 'main.mjs': createHash('sha256').update(text).digest('hex') } };
  const save = () => writeFileSync(join(dir, 'distribution.json'), JSON.stringify(manifest));
  save(); return { dir, manifest, save };
}
test('payload validation rejects tampering, hidden user data, extra files and symlinks', t => {
  const f = payload(t); assert.equal(validatePayload(f.dir).version, '0.1.0');
  writeFileSync(join(f.dir, 'main.mjs'), 'tampered'); assert.throws(() => validatePayload(f.dir), /校验失败/);
  writeFileSync(join(f.dir, 'main.mjs'), 'console.log("test");\n');
  writeFileSync(join(f.dir, 'extra'), 'extra'); assert.throws(() => validatePayload(f.dir), /未登记/); rmSync(join(f.dir, 'extra'));
  mkdirSync(join(f.dir, 'credentials')); writeFileSync(join(f.dir, 'credentials/auth.json'), '{}');
  assert.throws(() => validatePayload(f.dir), /排除项/); rmSync(join(f.dir, 'credentials'), { recursive: true });
  symlinkSync('/tmp', join(f.dir, 'link')); assert.throws(() => validatePayload(f.dir), /符号链接/);
});
test('manifest traversal cannot authorize outside files', t => {
  const f = payload(t); f.manifest.files['../outside'] = 'a'.repeat(64); f.save();
  assert.throws(() => validatePayload(f.dir), /清单无效/);
});
test('formula uses fixed versions, actual checksum, stable opt path and executable wrapper', () => {
  const formula = renderFormula({ repository: 'owner/pi-agent', version: '1.2.3', sha256: 'b'.repeat(64) });
  assert.match(formula, /releases\/download\/v1\.2\.3\/pi-agent-1\.2\.3-macos-arm64\.tar\.gz/);
  assert.match(formula, /sha256 "b{64}"/); assert.match(formula, /opt_libexec/); assert.match(formula, /chmod 0755/);
  for (const repository of ['owner/repo";system("bad")', '../repo', 'https://example.com']) assert.throws(() => renderFormula({ repository, version: '1.2.3', sha256: 'b'.repeat(64) }));
  assert.throws(() => renderFormula({ repository: 'owner/repo', version: 'latest', sha256: 'b'.repeat(64) }));
});
