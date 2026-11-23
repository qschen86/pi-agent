import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installOptionalRuntime, componentBinary, isComponentInstalled } from '../src/optional-installer.mjs';
for(const runtime of ['codex','claude-code']) test(`${runtime}: pinned installation is staged, skips scripts, preserves credentials and reuses verified component`,async t=>{
 const root=mkdtempSync(join(tmpdir(),'optional-install-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'credentials'));writeFileSync(join(root,'credentials/keep'),'original');
 const npmCli=join(root,'npm-cli.js');writeFileSync(npmCli,'fixture');let installs=0;
 const execute=async(bin,args,options)=>{assert.equal(options.env.OPENAI_API_KEY,undefined);if(args[0]!==npmCli)return;
  installs++;assert.ok(args.includes('--ignore-scripts'));assert.ok(args.includes('--fetch-retries=0'));
  const stage=args[args.indexOf('--prefix')+1];assert.ok(!existsSync(join(root,'runtime/components',runtime)));
  const pkg=runtime==='codex'?'@openai/codex':'@anthropic-ai/claude-agent-sdk';const dir=join(stage,'node_modules',pkg);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'package.json'),JSON.stringify({version:'fixture-version'}));
  const file=runtime==='codex'?join(stage,'node_modules/.bin/codex'):join(stage,'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude');mkdirSync(join(file,'..'),{recursive:true});writeFileSync(file,'fixture');
 };
 const options={root,runtime,npmCli,manifestRoot:resolve('apps/homebrew/runtime-manifests'),execute};
 assert.equal((await installOptionalRuntime(options)).reused,false);assert.ok(componentBinary(root,runtime).startsWith(realpathSync(root)));
 assert.equal((await installOptionalRuntime(options)).reused,true);assert.equal(installs,1);assert.equal(readFileSync(join(root,'credentials/keep'),'utf8'),'original');
 writeFileSync(componentBinary(root,runtime),'corrupted component');
 await assert.rejects(installOptionalRuntime(options),/校验失败/);
});
test('failed download never publishes installed state and can retry',async t=>{
 const root=mkdtempSync(join(tmpdir(),'optional-fail-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const npmCli=join(root,'npm-cli.js');writeFileSync(npmCli,'fixture');
 await assert.rejects(installOptionalRuntime({root,runtime:'codex',manifestRoot:resolve('apps/homebrew/runtime-manifests'),npmCli,execute:async()=>{throw Error('vendor secret body');}}),/安装失败/);
 assert.equal(existsSync(join(root,'runtime/components/codex')),false);
});
test('antigravity: staged download verifies sha512, installs isolated binary, reuses verified component and rejects tampering', async t => {
  const root = mkdtempSync(join(tmpdir(), 'optional-agy-'));
  const manifests = mkdtempSync(join(tmpdir(), 'optional-agy-manifest-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(manifests, { recursive: true, force: true }); });
  const archivePayload = Buffer.from('synthetic-antigravity-archive');
  const sha512 = createHash('sha512').update(archivePayload).digest('hex');
  mkdirSync(join(manifests, 'antigravity'), { recursive: true });
  writeFileSync(join(manifests, 'antigravity/manifest.json'), JSON.stringify({
    schema: 1, runtime: 'antigravity', platform: 'darwin_arm64', version: '1.5.14',
    url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14/darwin-arm/cli_mac_arm64.tar.gz',
    sha512
  }));
  let downloads = 0;
  const execute = async (bin, args) => {
    if (bin === '/usr/bin/curl') {
      downloads++;
      const outPath = args[args.indexOf('--output') + 1];
      writeFileSync(outPath, archivePayload);
      return;
    }
    if (bin === '/usr/bin/tar') {
      const extractDir = args[args.indexOf('-C') + 1];
      writeFileSync(join(extractDir, 'antigravity'), '#!/bin/sh\necho 1.5.14\n');
      return;
    }
  };
  const opts = { root, runtime: 'antigravity', manifestRoot: manifests, execute };
  assert.equal(isComponentInstalled(root, 'antigravity'), false);
  const first = await installOptionalRuntime(opts);
  assert.equal(first.installed, true);
  assert.equal(first.reused, false);
  assert.equal(first.version, '1.5.14');
  assert.equal(isComponentInstalled(root, 'antigravity'), true);
  assert.ok(componentBinary(root, 'antigravity').startsWith(realpathSync(root)));
  const second = await installOptionalRuntime(opts);
  assert.equal(second.reused, true);
  assert.equal(downloads, 1);
  writeFileSync(componentBinary(root, 'antigravity'), 'tampered');
  await assert.rejects(installOptionalRuntime(opts), /校验失败/);
});
