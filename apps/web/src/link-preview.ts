import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Hono } from 'hono';

// Preview fetching never carries platform cookies, credentials or a Referer.
// Pin a public IPv4 for every request, including redirects and favicon requests.
export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number) as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
export function previewUrl(value: string): URL {
  if (value.length > 8192 || /[\s\\\u0000-\u001f]/u.test(value)) throw Error('invalid URL');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !url.hostname.includes('.')) throw Error('invalid URL');
  if (isIP(url.hostname) && !publicIPv4(url.hostname)) throw Error('private URL');
  url.hash = '';
  return url;
}
type Page = { url: string; type: string; body: Buffer };
export type PreviewReader = (url: string, maxBytes: number, signal: AbortSignal) => Promise<Page>;
export const readPublicPage: PreviewReader = async (value, maxBytes, signal) => {
  let url = previewUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    let addresses;
    try {
      addresses = await Promise.race([lookup(url.hostname, { family: 4, all: true }), new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      })]);
    } finally { if (abort) signal.removeEventListener('abort', abort); }
    if (!addresses.length || addresses.some(row => !publicIPv4(row.address))) throw Error('private destination');
    const address = addresses[0]!.address;
    const result = await new Promise<Page & { redirect?: string }>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        signal, family: 4,
        lookup: (_host, _options, callback) => callback(null, address, 4),
        headers: { 'user-agent': 'pi-agent-link-preview/1', accept: 'text/html,image/*;q=0.8', 'accept-encoding': 'identity' },
      }, response => {
        const status = response.statusCode || 0;
        const type = String(response.headers['content-type'] || '').split(';')[0]!.toLowerCase();
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.destroy(); resolve({ url: url.href, type: '', body: Buffer.alloc(0), redirect: response.headers.location }); return;
        }
        if (status < 200 || status >= 300) { response.destroy(); reject(Error('preview unavailable')); return; }
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => {
          const remaining = maxBytes - size;
          size += chunk.length;
          if (size > maxBytes) {
            if (['text/html', 'application/xhtml+xml'].includes(type)) {
              chunks.push(chunk.subarray(0, remaining));
              resolve({ url: url.href, type, body: Buffer.concat(chunks) }); response.destroy();
            } else response.destroy(Error('preview too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => resolve({ url: url.href, type, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject); req.end();
    });
    if (!result.redirect) return result;
    url = previewUrl(new URL(result.redirect, url).href);
  }
  throw Error('too many redirects');
};
const decode = (text: string) => text.replace(/&(?:amp|quot|apos|lt|gt|#(\d+)|#x([\da-f]+));/gi, (m, decimal, hex) => {
  if (decimal || hex) { const n = parseInt(decimal || hex, decimal ? 10 : 16); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }
  return ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' } as Record<string, string>)[m.toLowerCase()] || m;
});
function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) result[match[1]!.toLowerCase()] = decode(match[2] ?? match[3] ?? match[4] ?? '');
  return result;
}
export function htmlPreview(html: string, base: string) {
  // Parse bounded metadata only; no scripts, markup or styles are ever rendered.
  html = html.replace(/<!--[^]*?-->|<script\b[^]*?<\/script\s*>|<style\b[^]*?<\/style\s*>/gi, '');
  let title = '', icon = '';
  for (const match of html.matchAll(/<(meta|link)\b[^>]*>/gi)) {
    const attr = attributes(match[0]);
    if (match[1]!.toLowerCase() === 'meta' && (attr.property || attr.name)?.toLowerCase() === 'og:title' && attr.content) title ||= attr.content;
    if (match[1]!.toLowerCase() === 'link' && attr.rel?.toLowerCase().split(/\s+/).includes('icon') && attr.href) icon ||= attr.href;
  }
  title ||= decode(/<title\b[^>]*>([^]*?)<\/title\s*>/i.exec(html)?.[1] || '');
  title = title.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
  return { title, icon: new URL(icon || '/favicon.ico', base).href };
}
export async function loadLinkPreview(value: string, read: PreviewReader = readPublicPage) {
  const url = previewUrl(value);
  const fallback = { title: url.hostname, favicon: '' };
  const signal = AbortSignal.timeout(5000);
  try {
    const page = await read(url.href, 256 * 1024, signal);
    if (!['text/html', 'application/xhtml+xml'].includes(page.type)) return fallback;
    const meta = htmlPreview(page.body.toString('utf8'), page.url);
    const title = meta.title || fallback.title;
    let favicon = '';
    const candidates = [...new Set([meta.icon, new URL('/favicon.ico', page.url).href])];
    for (const candidate of candidates) {
      try {
        previewUrl(candidate);
        const image = await read(candidate, 64 * 1024, signal);
        if (['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/gif'].includes(image.type) && image.body.length) {
          favicon = `data:${image.type};base64,${image.body.toString('base64')}`; break;
        }
      } catch { /* Broken icons do not hide a usable title or link. */ }
    }
    return { title, favicon };
  } catch { return fallback; }
}
export function mountLinkPreviewRoutes(app: Hono, load = loadLinkPreview) {
  let running = 0;
  app.post('/api/link-preview', async c => {
    c.header('Cache-Control', 'no-store');
    if (running >= 4) return c.json({ error: '链接预览繁忙' }, 429);
    let url: string;
    try { const data = await c.req.json(); if (typeof data.url !== 'string') throw Error(); url = previewUrl(data.url).href; }
    catch { return c.json({ error: '链接暂不支持预览' }, 400); }
    running++;
    try { return c.json(await load(url)); }
    finally { running--; }
  });
}
