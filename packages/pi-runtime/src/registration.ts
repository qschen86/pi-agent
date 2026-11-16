/** User-owned runtime locator. It contains no tool policy or provider credentials. */
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
export function registrationPath():string { return process.env.PI_RUNTIME_REGISTRATION ?? join(homedir(),'.config/pi-runtime/connection.json'); }
export function registeredRuntimeExecutable(file=registrationPath()):string|undefined {
  if(!isAbsolute(file))throw new Error('Pi runtime registration must be an absolute path');
  if(!existsSync(file))return;
  const raw=JSON.parse(readFileSync(file,'utf8')) as Record<string,unknown>;
  if(!raw||Array.isArray(raw)||raw.version!==1||typeof raw.executable!=='string'||!isAbsolute(raw.executable)||Object.keys(raw).some(k=>!['version','executable'].includes(k)))throw new Error('Invalid Pi runtime registration');
  const executable=realpathSync(raw.executable);
  if(!statSync(executable).isFile())throw new Error('Registered Pi runtime is not a file');
  accessSync(executable,constants.X_OK);return executable;
}
