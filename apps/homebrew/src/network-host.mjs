import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectRuntimeNetwork } from './runtime-network-probe.mjs';

export function isolatedEnv(root) {
  const env = Object.fromEntries(['USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SHELL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return { ...env, HOME: join(root, 'runtime/home'), TMPDIR: join(root, 'runtime/tmp'),
    PATH: `${join(process.execPath, '..')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    CODEX_HOME: join(root, 'credentials/codex'), CLAUDE_CONFIG_DIR: join(root, 'credentials/claude'),
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}

export function antigravityEnv(root) {
  return { ...isolatedEnv(root), HOME: join(root, 'credentials/antigravity') };
}

// curl and native runtimes receive the same proxy variables. No personal curlrc is read.
export function curlFetch(root) {
  const allowed = new Set(['https://ipconfig.io/json', 'https://api.ipapi.is/', 'https://chatgpt.com/backend-api/wham/usage', 'https://api.anthropic.com/v1/messages', 'https://accounts.google.com/generate_204']);
  return async (url, options = {}) => {
    if (!allowed.has(String(url))) throw Error('网络检查地址无效');
    return new Promise((yes, no) => {
      const args = ['-q', '--silent', '--show-error', '--max-time', '8', '--max-redirs', '0', '--proto', '=https', '--request', options.method || 'GET', '--header', 'accept: application/json', '--write-out', '\n%{http_code}', String(url)];
      if (options.body) args.push('--header', 'content-type: application/json', '--data-binary', '@-');
      const child = spawn('/usr/bin/curl', args, { env: isolatedEnv(root), stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = []; let bytes = 0; let settled = false;
      const fail = () => { if (!settled) { settled = true; child.kill(); no(Error('网络检查暂不可用')); } };
      child.on('error', fail); child.stderr.resume();
      const timeout = setTimeout(fail, 10_000); timeout.unref();
      child.stdout.on('data', value => { bytes += value.length; if (bytes > 65_536) fail(); else chunks.push(value); });
      child.once('close', code => {
        clearTimeout(timeout); if (settled) return;
        if (code !== 0) return fail();
        const output = Buffer.concat(chunks).toString('utf8'); const split = output.lastIndexOf('\n'); const status = Number(output.slice(split + 1));
        if (status < 200 || status > 599) return fail();
        settled = true; yes(new Response([204, 205, 304].includes(status) ? null : output.slice(0, split), { status }));
      });
      child.stdin.on('error', () => {}); child.stdin.end(options.body || '');
    });
  };
}

export function createNetworkInspector({ root, manifestRoot, fetchImpl = curlFetch(root) }) {
  return async (runtime, apiKey) => {
    const policies = JSON.parse(readFileSync(join(manifestRoot, 'regions.json'), 'utf8'));
    const policy = policies[runtime];
    return inspectRuntimeNetwork({ runtime, fetchImpl, apiKey,
      regionPolicy: policy && { ...policy, runtime, expiresAt: Date.parse(policies.expiresAt) },
      checkConnectivity: async kind => {
        const source = kind === 'codex'
          ? 'https://chatgpt.com/backend-api/wham/usage'
          : kind === 'claude-code'
            ? 'https://api.anthropic.com/v1/messages'
            : 'https://accounts.google.com/generate_204';
        const response = await fetchImpl(source);
        return { source, reachable: response.ok || [401, 405].includes(response.status) };
      }
    });
  };
}
