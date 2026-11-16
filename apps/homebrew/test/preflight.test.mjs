import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessEnvironment, inspectEnvironment, REQUIREMENTS } from '../src/preflight.mjs';

const good = { platform: 'darwin', arch: 'arm64', appleSilicon: true, macosVersion: '14.0', memoryBytes: REQUIREMENTS.memoryBytes, freeBytes: REQUIREMENTS.freeBytes, seatbelt: true };
test('exactly 16GiB memory and 40 decimal GB free are accepted', () => {
  assert.equal(assessEnvironment(good).eligible, true);
});
test('hardware and system failures cannot be masked by other passing checks', () => {
  for (const change of [{ arch: 'x64' }, { appleSilicon: false }, { platform: 'linux' }, { macosVersion: '13.6.9' }, { macosVersion: '' }, { memoryBytes: REQUIREMENTS.memoryBytes - 1 }, { freeBytes: REQUIREMENTS.freeBytes - 1 }, { seatbelt: false }]) {
    assert.equal(assessEnvironment({ ...good, ...change }).eligible, false, JSON.stringify(change));
  }
});
test('missing and non-finite capacity readings block installation', () => {
  for (const key of ['memoryBytes', 'freeBytes']) for (const value of [undefined, NaN, Infinity, -1]) {
    assert.equal(assessEnvironment({ ...good, [key]: value }).eligible, false);
  }
});
test('Rosetta is rejected even when the physical host is Apple Silicon', () => {
  const report = inspectEnvironment('/private/tmp/new-installation/not-created', {
    platform: 'darwin', arch: 'x64', totalmem: () => good.memoryBytes,
    exec: command => command.endsWith('sysctl') ? '1' : '26.6.2',
    exists: () => true, statfs: () => ({ bavail: 100_000_000, bsize: 4096 })
  });
  assert.equal(report.eligible, false);
  assert.equal(report.checks.find(c => c.id === 'architecture').passed, false);
});
test('failed OS probes do not silently assume compatibility', () => {
  const report = inspectEnvironment('/private/tmp', { platform: 'darwin', arch: 'arm64', totalmem: () => good.memoryBytes, exec: () => { throw Error('unavailable'); }, statfs: () => { throw Error('unavailable'); } });
  assert.equal(report.eligible, false);
  assert.equal(report.checks.find(c => c.id === 'disk').passed, false);
});
