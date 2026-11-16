import type { AuthSessions, AuthSessionRecord, AuthFailureReason } from './auth-sessions.js';
export type AuthResult = { ok: true; source: 'bearer' | 'cookie'; record: AuthSessionRecord } | { ok: false; reason: AuthFailureReason; id?: string };
export function authenticateApiRequest(auth: AuthSessions, authorization: string | undefined, cookie: string | undefined): AuthResult {
 if (authorization !== undefined) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
  if (!match) return { ok: false, reason: 'malformed' };
  const result = auth.inspectFresh(match[1]!);
  return result.ok ? { ...result, source: 'bearer' } : result;
 }
 const result = auth.inspect(cookie); return result.ok ? { ...result, source: 'cookie' } : result;
}
