import { appData } from './app-data.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the Android push credentials and the APK release live. An explicit environment variable always wins;
 * otherwise files the operator placed in this instance's own data directory switch the feature on, so enabling
 * it is a normal deploy and needs no service-manager change or restart. A missing file simply leaves it off.
 */
export interface AndroidConfig { fcmServiceAccount?: string; releaseDir?: string }
export function resolveAndroidConfig(env: Record<string, string | undefined>, dataDir?: string): AndroidConfig {
  const out: AndroidConfig = {}, data = dataDir ? appData(dataDir, 'android') : undefined;
  const account = env['PI_ANDROID_FCM_SERVICE_ACCOUNT'] || (dataDir && existsSync(data!.path('android-firebase', 'service-account.json')) ? data!.path('android-firebase', 'service-account.json') : undefined);
  if (account) out.fcmServiceAccount = account;
  // A release directory without its manifest would answer 503 instead of "nothing published", so it needs release.json.
  const release = env['PI_ANDROID_RELEASE_DIR'] || (dataDir && existsSync(data!.path('android-release', 'release.json')) ? data!.path('android-release') : undefined);
  if (release) out.releaseDir = release;
  return out;
}
