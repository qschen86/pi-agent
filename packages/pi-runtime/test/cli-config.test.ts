import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
it('refuses an explicitly configured missing profile instead of silently starting without community policy',()=>{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../bin/pi-runtime.mjs',import.meta.url)),'--describe'],{env:{...process.env,PI_RUNTIME_PROFILE:'/private/tmp/pi-profile-does-not-exist/config.json'},encoding:'utf8'});
  expect(result.status).not.toBe(0);expect(result.stderr).toContain('Requested runtime profile does not exist');expect(result.stdout).toBe('');
});
