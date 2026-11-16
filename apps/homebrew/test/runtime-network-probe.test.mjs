import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectRuntimeNetwork } from '../src/runtime-network-probe.mjs';
import { evaluateRuntimeNetwork, withRuntimeNetworkGate } from '../src/runtime-network-gate.mjs';

const exit = { ip: '8.8.8.8', country_iso: 'US', asn: 'AS15169', asn_org: 'Fixture only' };
const type = { ip: exit.ip, is_datacenter: false, is_bogon: false, location: { country_code: 'US' }, is_mobile: true, is_proxy: false, is_vpn: false };
// All fixtures are synthetic: no live queries or claim about the sample IP's real type.
function setup({ runtime = 'codex', exitValue = exit, typeValue = type, finalExit = exitValue, status = 200 } = {}) {
  const calls = []; let exits = 0;
  const options = { runtime, now: () => 1000, apiKey: 'private-test-key',
    regionPolicy: { runtime, source: 'https://provider.example/regions', expiresAt: 2000, countries: ['US'] },
    checkConnectivity: async () => ({ reachable: true, source: 'https://provider.example/connectivity' }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return url === 'https://ipconfig.io/json' ? Response.json(exits++ ? finalExit : exitValue) : Response.json(typeValue, { status });
    }
  };
  return { calls, options };
}
for (const runtime of ['codex', 'claude-code']) {
  test(`${runtime}: exact-IP two-source checks pass supported non-datacenter and retain mobile flag`, async () => {
    const { calls, options } = setup({ runtime }); const result = await inspectRuntimeNetwork(options);
    assert.equal(evaluateRuntimeNetwork({ ...result, runtime, now: 1000 }).allowed, true);
    assert.equal(result.report.checks.networkType.value, 'non-datacenter');
    assert.equal(result.report.checks.networkType.flags.is_mobile, true);
    assert.equal(calls.length, 3);
    assert.equal(calls[1].url, 'https://api.ipapi.is/');
    assert.deepEqual(JSON.parse(calls[1].options.body), { q: exit.ip, key: 'private-test-key' });
    assert.ok(calls.every(call => !call.url.includes('private-test-key') && call.options.redirect === 'error' && call.options.credentials === 'omit'));
    assert.equal(JSON.stringify(result).includes('private-test-key'), false);
  });
}
test('anonymous ownership-only response never infers residential from ISP', async () => {
  const { options } = setup({ typeValue: { ip: exit.ip, company: 'Residential ISP', country: 'United States' } });
  delete options.apiKey;
  const result = await inspectRuntimeNetwork(options);
  assert.equal(result.failure, 'classification-unavailable');
  assert.equal(evaluateRuntimeNetwork({ ...result, runtime: 'codex', now: 1000 }).allowed, false);
});
test('datacenter, missing boolean, wrong IP, conflicting country and changed egress all block install', async () => {
  const cases = [
    { typeValue: { ...type, is_datacenter: true } },
    { typeValue: { ...type, is_datacenter: 'false' } },
    { typeValue: { ...type, ip: '1.1.1.1' } },
    { typeValue: { ...type, location: { country_code: 'CA' } } },
    { finalExit: { ...exit, ip: '1.1.1.1' } },
    { typeValue: { ...type, is_bogon: true } },
    { status: 429, typeValue: { error: 'quota' } }
  ];
  for (const value of cases) {
    const { options } = setup(value); let installed = false;
    await assert.rejects(withRuntimeNetworkGate({ runtime: 'codex', stage: 'install', now: () => 1000,
      inspect: () => inspectRuntimeNetwork(options), operation: () => { installed = true; } }), { code: 'RUNTIME_NETWORK_BLOCKED' });
    assert.equal(installed, false);
  }
});
test('unsupported, absent or expired region policies cannot pass', async () => {
  for (const regionPolicy of [undefined, { runtime: 'claude-code', countries: ['US'] }, { runtime: 'codex', source: 'https://example.test', expiresAt: 900, countries: ['US'] }, { runtime: 'codex', source: 'https://example.test', expiresAt: 2000, countries: ['CA'] }]) {
    const { options } = setup(); options.regionPolicy = regionPolicy;
    assert.equal(evaluateRuntimeNetwork({ ...await inspectRuntimeNetwork(options), runtime: 'codex', now: 1000 }).allowed, false);
  }
});
test('transport errors and missing provider connectivity block without exposing errors', async () => {
  const { options } = setup(); options.checkConnectivity = undefined;
  assert.equal(evaluateRuntimeNetwork({ ...await inspectRuntimeNetwork(options), runtime: 'codex', now: 1000 }).allowed, false);
  options.fetchImpl = async () => { throw Error('secret transport diagnostics'); };
  const result = await inspectRuntimeNetwork(options);
  assert.equal(result.failure, 'lookup-unavailable');
  assert.equal(JSON.stringify(result).includes('secret transport diagnostics'), false);
});
test('redirect, oversized and malformed responses remain blocked', async () => {
  for (const fetchImpl of [
    async () => new Response(null, { status: 302, headers: { location: 'https://other.example' } }),
    async () => new Response('x'.repeat(40_000)),
    async () => new Response('not-json')
  ]) {
    const { options } = setup(); options.fetchImpl = fetchImpl;
    assert.equal(evaluateRuntimeNetwork({ ...await inspectRuntimeNetwork(options), runtime: 'codex', now: 1000 }).allowed, false);
  }
});
