import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { NETWORK_REPORT_TTL_MS } from './runtime-network-gate.mjs';

const EXIT_URL = 'https://ipconfig.io/json';
const TYPE_URL = 'https://api.ipapi.is/';
const ipIdentity = value => {
  if (typeof value !== 'string' || !isIP(value)) return undefined;
  return isIP(value) === 6 ? new URL(`http://[${value}]`).hostname.toLowerCase() : value;
};
const evidence = (status, source, extra = {}) => ({ status, source, ...extra });

// Uses the caller's runtime network transport: do not silently bypass its proxy.
// Do not log requests/bodies: the type lookup may contain the user's own API key.
export async function inspectRuntimeNetwork({ runtime, fetchImpl, apiKey, regionPolicy, checkConnectivity, now = () => Date.now() }) {
  if (!['codex', 'claude-code'].includes(runtime)) throw Error('不支持的可选运行时');
  if (typeof fetchImpl !== 'function') throw Error('必须指定与运行时一致的网络传输');
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey))) throw Error('IP 检测 Key 无效');
  const report = { runtime, checkedAt: now(), networkId: '', checks: {
    region: evidence('unknown', regionPolicy?.source || 'provider-policy-unavailable'),
    connectivity: evidence('unknown', 'provider-connectivity-unavailable'),
    networkType: evidence('unknown', TYPE_URL, { value: 'unknown' })
  } };
  let failure;
  async function request(url, options = {}) {
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(8000), credentials: 'omit', headers: { accept: 'application/json', ...options.headers } });
      if (!response.ok) { failure = response.status === 429 ? 'rate-limited' : 'lookup-failed'; return; }
      if (!response.body) { failure = 'invalid-response'; return; }
      const reader = response.body.getReader(); const chunks = []; let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.length;
          if (length > 32_768) { await reader.cancel(); failure = 'invalid-response'; return; }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || data.error_code) { failure = 'lookup-failed'; return; }
      return data;
    } catch { failure = 'lookup-unavailable'; }
  }
  const exit = await request(EXIT_URL);
  const ip = ipIdentity(exit?.ip);
  if (!ip) return { report, networkId: '', failure: failure || 'invalid-exit-ip' };
  report.networkId = createHash('sha256').update(ip).digest('hex');
  report.exit = { ip: exit.ip, countryCode: exit.country_iso, asn: exit.asn, organization: exit.asn_org };
  const type = await request(TYPE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: exit.ip, ...(apiKey ? { key: apiKey.trim() } : {}) }) });
  if (type && ipIdentity(type.ip) !== ip) failure = 'ip-mismatch';
  else if (type) {
    // Only an explicit boolean is usable. Never infer a type from an ISP/ASN name.
    const value = type.is_datacenter === false ? 'non-datacenter' : type.is_datacenter === true ? 'datacenter' : 'unknown';
    report.checks.networkType = evidence(value === 'non-datacenter' && type.is_bogon !== true ? 'passed' : value === 'unknown' ? 'unknown' : 'failed', TYPE_URL, { value,
      flags: Object.fromEntries(['is_mobile', 'is_vpn', 'is_proxy', 'is_tor'].filter(key => typeof type[key] === 'boolean').map(key => [key, type[key]])) });
    if (value === 'unknown') failure = 'classification-unavailable';
    const country = exit.country_iso;
    const typeCountry = type.location?.country_code;
    const validPolicy = regionPolicy?.runtime === runtime && typeof regionPolicy.source === 'string' && regionPolicy.source.startsWith('https://') &&
      Number.isFinite(regionPolicy.expiresAt) && regionPolicy.expiresAt > now() && Array.isArray(regionPolicy.countries) && regionPolicy.countries.length > 0;
    if (typeof country === 'string' && /^[A-Z]{2}$/.test(country) && country === typeCountry && validPolicy) {
      report.checks.region = evidence(regionPolicy.countries.includes(country) ? 'passed' : 'failed', regionPolicy.source, { countryCode: country });
    }
    // This probe never logs in or sends credentials to OpenAI/Anthropic.
    if (checkConnectivity) {
      try {
        const result = await checkConnectivity(runtime);
        if (typeof result?.source === 'string' && result.source.startsWith('https://')) report.checks.connectivity = evidence(result.reachable === true ? 'passed' : 'failed', result.source);
      } catch { /* Remains unknown and blocked. */ }
    }
  }
  // Check egress again after lookups to reject an exit changed during the check.
  const finalExit = await request(EXIT_URL);
  const finalIp = ipIdentity(finalExit?.ip);
  const networkId = finalIp ? createHash('sha256').update(finalIp).digest('hex') : '';
  if (networkId !== report.networkId || finalExit?.country_iso !== exit.country_iso) {
    report.checks.region.status = 'unknown'; report.checks.networkType.status = 'unknown'; failure = 'exit-changed';
  }
  if (now() - report.checkedAt >= NETWORK_REPORT_TTL_MS) failure = 'expired-report';
  return { report, networkId, ...(failure ? { failure } : {}) };
}
