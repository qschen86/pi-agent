import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const CORE_COMPONENTS = Object.freeze(['sessions', 'quick-actions', 'todos', 'memory', 'artifacts', 'development', 'settings']);

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw Error('管理员密码需要 12–1024 个字符');
  const salt = randomBytes(24).toString('hex');
  return { algorithm: 'scrypt', salt, digest: scryptSync(password, salt, 64).toString('hex') };
}
export function verifyPassword(password, record) {
  if (typeof password !== 'string' || password.length > 1024 || record?.algorithm !== 'scrypt' || !/^[a-f0-9]{48}$/.test(record.salt ?? '') || !/^[a-f0-9]{128}$/.test(record.digest ?? '')) return false;
  return timingSafeEqual(scryptSync(password, record.salt, 64), Buffer.from(record.digest, 'hex'));
}

/** Writes only a NEW, operator-selected root. Config is published last; existing installs are never overwritten. */
export function initializeInstallation({ root, password, passwordConfirmation, environment, model, runtimeKind = 'pi', networkApiKey }) {
  if (!environment?.eligible) throw Error('设备检查未通过，不能初始化');
  if (!isAbsolute(root ?? '') || resolve(root) === dirname(resolve(root))) throw Error('数据位置必须是独立的绝对路径');
  root = resolve(root);
  if (!existsSync(dirname(root)) || lstatSync(dirname(root)).isSymbolicLink()) throw Error('数据目录的父目录必须已存在且不是符号链接');
  if (existsSync(root)) throw Error('数据位置已经存在，请使用恢复流程，不能覆盖初始化');
  if (password !== passwordConfirmation) throw Error('两次密码不一致');
  // Model identity is chosen explicitly; never assume a personal models.json is present.
  if (!['pi', 'codex', 'claude-code'].includes(runtimeKind)) throw Error('模型配置无效');
  if (runtimeKind === 'pi' && (model?.provider !== 'deepseek' || typeof model.id !== 'string' || !/^[a-zA-Z0-9._:-]{1,120}$/.test(model.id) || typeof model.apiKey !== 'string' || !model.apiKey.trim() || model.apiKey.length > 4096 || /[\r\n\0]/.test(model.apiKey))) throw Error('模型配置无效');
  if (networkApiKey !== undefined && (typeof networkApiKey !== 'string' || !networkApiKey.trim() || networkApiKey.length > 4096 || /[\r\n\0]/.test(networkApiKey))) throw Error('网络检测 Key 无效');
  const admin = hashPassword(password);
  const stage = `${root}.initializing-${randomBytes(12).toString('hex')}`;
  mkdirSync(stage, { mode: 0o700 });
  try {
    for (const dir of ['data', 'workspaces', 'credentials', 'runtime', 'backups', 'logs']) mkdirSync(join(stage, dir), { mode: 0o700 });
    const save = (file, data) => writeFileSync(join(stage, file), JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    save('credentials/admin.json', admin);
    mkdirSync(join(stage, 'credentials/pi'), { mode: 0o700 });
    save('credentials/pi/auth.json', runtimeKind === 'pi' ? { deepseek: { type: 'api_key', key: model.apiKey.trim() } } : {});
    save('credentials/pi/settings.json', runtimeKind === 'pi' ? { defaultProvider: model.provider, defaultModel: model.id } : {});
    for (const dir of ['credentials/codex', 'credentials/claude', 'runtime/home', 'runtime/tmp']) mkdirSync(join(stage, dir), { mode: 0o700 });
    if (networkApiKey) save('credentials/network.json', { ipapiKey: networkApiKey.trim() });
    // Optional runtimes have no purchased subscription in a new instance.
    save('data/runtime-billing.json', { pi: { mode: 'api' }, codex: { mode: 'api' }, 'claude-code': { mode: 'api' } });
    save('installation.json', {
      schema: 1, edition: 'mac-local-core', state: 'configured', components: CORE_COMPONENTS, runtimeKind,
      ...(runtimeKind !== 'pi' ? { onboarding: { component: 'pending', login: 'pending' } } : {}),
      // This does not assert that a model call or task has passed. Runtime onboarding records those separately.
      acceptance: { modelConnection: 'pending', firstTask: 'pending' },
      paths: { data: 'data', workspace: 'workspaces', credentials: 'credentials/pi' },
      access: { host: '127.0.0.1', remote: false }, autoStart: false
    });
    // A competing initializer must not replace an existing directory, including an empty one.
    mkdirSync(root, { mode: 0o700 });
    try {
      // Move the staged tree into the reserved root; config is the last published completion marker.
      for (const dir of ['data', 'workspaces', 'credentials', 'runtime', 'backups', 'logs']) renameSync(join(stage, dir), join(root, dir));
      renameSync(join(stage, 'installation.json'), join(root, 'installation.json'));
      chmodSync(root, 0o700);
    } catch (error) {
      // Remove only the root reserved by this invocation. Never touch a pre-existing install.
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
    return { root, state: 'configured', acceptance: { modelConnection: 'pending', firstTask: 'pending' } };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

export function readInstallation(root) {
  const file = join(root, 'installation.json');
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) throw Error('安装状态无效');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (config.schema !== 1 || config.edition !== 'mac-local-core') throw Error('安装状态版本不兼容');
  return config;
}
