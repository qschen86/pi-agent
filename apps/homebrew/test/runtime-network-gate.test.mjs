import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRuntimeNetwork, withRuntimeNetworkGate, NETWORK_REPORT_TTL_MS } from '../src/runtime-network-gate.mjs';

const now = 1_000_000;
const input = runtime => ({ runtime, networkId: 'network-a', now, report: {
  runtime, networkId: 'network-a', checkedAt: now,
  checks: {
    region: { status: 'passed', source: 'test-fixture' },
    connectivity: { status: 'passed', source: 'test-fixture' },
    networkType: { status: 'passed', source: 'test-fixture', value: 'residential' }
  }
} });

for (const runtime of ['codex', 'claude-code', 'antigravity']) {
  test(`${runtime}: only complete fresh evidence permits the operation`, async () => {
    const value = input(runtime); let called = 0;
    assert.equal(evaluateRuntimeNetwork(value).allowed, true);
    assert.equal(await withRuntimeNetworkGate({ runtime, stage: 'install', now: () => now, inspect: async () => value, operation: () => ++called }), 1);
    assert.equal(called, 1);
    assert.equal(evaluateRuntimeNetwork(value).accountSafetyGuaranteed, false);
  });
  test(`${runtime}: missing, failed, stale, changed-egress evidence blocks every stage`, async () => {
    const invalid = [];
    invalid.push({ ...input(runtime), report: undefined });
    for (const field of ['region', 'connectivity', 'networkType']) {
      for (const status of ['unknown', 'failed', 'high-risk', 'unsupported']) {
        const value = input(runtime); value.report.checks[field].status = status; invalid.push(value);
      }
      const value = input(runtime); delete value.report.checks[field].source; invalid.push(value);
    }
    const stale = input(runtime); stale.report.checkedAt -= NETWORK_REPORT_TTL_MS; invalid.push(stale);
    const future = input(runtime); future.report.checkedAt++; invalid.push(future);
    invalid.push({ ...input(runtime), networkId: 'network-b' });
    const other = input(runtime); other.report.runtime = runtime === 'codex' ? 'claude-code' : 'codex'; invalid.push(other);
    for (const value of ['datacenter', 'hosting', 'unknown', 'isp', undefined]) {
      const report = input(runtime); report.report.checks.networkType.value = value; invalid.push(report);
    }
    for (const value of invalid) {
      assert.equal(evaluateRuntimeNetwork(value).allowed, false);
      for (const stage of ['install', 'login', 'first-task']) {
        let called = false;
        await assert.rejects(withRuntimeNetworkGate({ runtime, stage, now: () => now, inspect: async () => value, operation: () => { called = true; } }), { code: 'RUNTIME_NETWORK_BLOCKED' });
        assert.equal(called, false);
      }
    }
  });
  test(`${runtime}: explicit non-datacenter evidence can pass; missing type cannot`, () => {
    const value = input(runtime); value.report.checks.networkType.value = 'non-datacenter';
    assert.equal(evaluateRuntimeNetwork(value).allowed, true);
    delete value.report.checks.networkType.value;
    assert.equal(evaluateRuntimeNetwork(value).allowed, false);
  });
}
test('probe errors never execute an installation', async () => {
  let called = false;
  await assert.rejects(withRuntimeNetworkGate({ runtime: 'codex', stage: 'install', inspect: async () => { throw Error('timeout'); }, operation: () => { called = true; } }), /timeout/);
  assert.equal(called, false);
});
