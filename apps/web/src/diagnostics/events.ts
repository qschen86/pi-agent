/**
 * 前端事件 client-event@1 的服务端校验（V1.4 §3.3）：只收白名单字段，枚举之外的值丢弃或记 unknown。
 */
import { boundedJson, redactStack, redactText, shapePath } from "./redact.js";

export const EVENT_NAMES = new Set([
  "js_error", "unhandled_rejection", "resource_error", "request_failed", "request_slow",
  "op_start", "op_success", "op_failure", "op_timeout", "op_cancelled", "op_recovered",
  "app_visibility_changed", "app_resumed", "page_ready", "startup_stage", "sw_update_detected", "sw_controller_changed",
  "telemetry_dropped", "report_opened", "network_window"
]);
/** 可淘汰的明细：当天容量到 80% 后先停写这一类 */
const SUCCESS_CLASS = new Set(["op_start", "op_success", "request_slow", "app_visibility_changed", "app_resumed", "page_ready", "startup_stage", "sw_update_detected", "sw_controller_changed", "report_opened", "network_window"]);
const ENTRIES = new Set(['primary', 'backup', 'local', 'unknown']);
/** Labels only, never persist a raw host, origin, IP, or user-supplied URL. Not an authorization check. */
export function ingressEntry(host: string | undefined): string {
  const h = (host ?? '').toLowerCase();
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/.test(h)) return 'local';
  if (/^gui\.harness\.fund(?::443)?$/.test(h)) return 'primary';
  if (/^gui-backup\.harness\.fund(?::9443)?$/.test(h)) return 'backup';
  return 'unknown';
}
const NETWORK_COUNTERS = ['api_started','api_dispatched','api_finished','api_failed','api_cancelled','api_timeouts','inflight_start','inflight_end','peak_inflight','network_start','network_end','peak_network','resource_count','zero_transfer_resources','transfer_bytes','encoded_bytes','decoded_bytes','headers_ms','queue_ms','sse_created','sse_opens','sse_reconnects','sse_errors','sse_messages','sse_data_bytes','sse_open','sse_connecting','sse_untracked'];
export const COMPONENTS = new Set(["session-list", "session-content", "message-submit", "app"]);
export const ERROR_TYPES = new Set(["js", "promise", "resource", "network", "timeout", "http_4xx", "http_5xx", "auth", "offline", "abort", "parse", "external", "unknown"]);
const RESULTS = new Set(["success", "failure", "timeout", "cancelled", "recovered"]);
const NET = new Set(["slow-2g", "2g", "3g", "4g", "wifi", "cellular", "ethernet", "unknown"]);
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const HEX64 = /^[a-f0-9]{64}$/;

export type ClientEvent = Record<string, unknown> & { event_id: string; event_name: string };

const id = (v: unknown) => (typeof v === "string" && ID.test(v) ? v : null);
const hex = (v: unknown) => (typeof v === "string" && HEX64.test(v) ? v : null);
const ms = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 86_400_000 ? Math.round(v) : null);
const iso = (v: unknown) => (typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
const pick = (set: Set<string>, v: unknown, fallback: string | null = null) => (typeof v === "string" && set.has(v) ? v : fallback);

/** 前端路由模板：#/rt/:id、#/notes 这类；资源 ID 一律换成 :id。 */
export function routeTemplate(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const hash = v.startsWith("#") ? v : null;
  if (hash) return `#${shapePath(hash.slice(1).split("?")[0]!)}`.slice(0, 80);
  if (v.startsWith("/")) return shapePath(v).slice(0, 80);
  return null;
}

/** 返回规范化后的事件；不合格返回 null。 */
export function normalizeClientEvent(raw: unknown): ClientEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r["schema"] !== "client-event@1") return null;
  const eventId = id(r["event_id"]), name = pick(EVENT_NAMES, r["event_name"]);
  if (!eventId || !name) return null;
  const ctx = r["context"] && typeof r["context"] === "object" ? r["context"] as Record<string, unknown> : {};
  const context = {
    entry: pick(ENTRIES, ctx['entry'], 'unknown'),
    browser: typeof ctx["browser"] === "string" ? String(ctx["browser"]).replace(/[^\w .-]/g, "").slice(0, 24) : null,
    os: typeof ctx["os"] === "string" ? String(ctx["os"]).replace(/[^\w .-]/g, "").slice(0, 16) : null,
    standalone: ctx["standalone"] === true, visible: ctx["visible"] !== false, online: ctx["online"] !== false,
    net: pick(NET, ctx["net"]), viewport: pick(new Set(["s", "m", "l"]), ctx["viewport"])
  };
  const event: ClientEvent = {
    event_id: eventId, event_name: name,
    occurred_at: iso(r["occurred_at"]),
    telemetry_session_id: id(r["telemetry_session_id"]), page_instance_id: id(r["page_instance_id"]),
    operation_id: id(r["operation_id"]), attempt_id: id(r["attempt_id"]), request_id: id(r["request_id"]),
    component_id: pick(COMPONENTS, r["component_id"]), route_template: routeTemplate(r["route_template"]),
    page_release: hex(r["page_release"]), sw_release: hex(r["sw_release"]),
    result: pick(RESULTS, r["result"]), error_type: r["error_type"] === undefined || r["error_type"] === null ? null : pick(ERROR_TYPES, r["error_type"], "unknown"),
    status: typeof r["status"] === "number" && Number.isInteger(r["status"]) && r["status"] >= 0 && r["status"] < 1000 ? r["status"] : null,
    reason: typeof r["reason"] === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(r["reason"]) ? r["reason"] : null,
    api_route: typeof r["api_route"] === "string" && r["api_route"].startsWith("/api/") ? shapePath(r["api_route"]) : null,
    method: typeof r["method"] === "string" && /^(GET|POST|PUT|PATCH|DELETE)$/.test(r["method"]) ? r["method"] : null,
    active_ms: ms(r["active_ms"]), wall_ms: ms(r["wall_ms"]),
    error_detail: r["error_detail"] ? redactText(r["error_detail"], 300) : null,
    stack: r["stack"] ? redactStack(r["stack"]) : null,
    environment: r["environment"] === "test" ? "test" : "prod",
    context
  };
  if (r["extra"] !== undefined) event["extra"] = boundedJson(r["extra"], 3, 120);
  if (name === 'network_window') {
    const x = r['extra'] as Record<string, unknown> | undefined;
    const start = iso(x?.['window_start']), duration = ms(x?.['window_ms']);
    if (!start || duration === null) return null;
    const extra: Record<string, unknown> = {window_start:start, window_ms:duration, resource_timing:x?.['resource_timing'] === true};
    for (const key of NETWORK_COUNTERS) {
      const v = x?.[key];
      if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 1e12) extra[key] = v;
    }
    event['extra'] = extra;
  }
  if (name === 'startup_stage') {
    if (typeof r['reason'] !== 'string' || !['surface-ready', 'cache-content', 'state-confirmed', 'send-ready', 'splash-hidden', 'startup-ended'].includes(r['reason']) || ms(r['wall_ms']) === null) return null;
    const x = r['extra'] && typeof r['extra'] === 'object' ? r['extra'] as Record<string, unknown> : {};
    const extra: Record<string, unknown> = { hidden: x['hidden'] === true, shell: x['shell'] === true };
    for (const [key, allowed] of Object.entries({ target_kind: ['single', 'room', 'list', 'other'], cache_source: ['disk', 'memory'], outcome: ['ready', 'surface-only', 'error', 'timeout', 'navigation', 'closed'], splash_reason: ['ready', 'error', 'timeout', 'navigation', 'not-shown'] })) {
      const value = x[key];
      if (typeof value === 'string' && allowed.includes(value)) extra[key] = value;
    }
    event['extra'] = extra;
  }
  if(name==='request_slow'&&r['timings']&&typeof r['timings']==='object'){
    const input=r['timings'] as Record<string,unknown>,timings:Record<string,number>={};
    for(const key of ['queue_ms','headers_ms','body_ms','decode_ms','server_ms','timeout_ms']){
      const value=ms(input[key]);if(value!==null)timings[key]=value;
    }
    event['timings']=timings;
  }
  for (const k of Object.keys(event)) if (event[k] === null) delete event[k];
  return event;
}

export const isSuccessClass = (e: ClientEvent) => SUCCESS_CLASS.has(e.event_name);
/** 会触发证据包的事件（V1.4 §4.1）；具体是否打包由前端限流后决定，服务端只用来复核。 */
export function isBundleTrigger(e: Record<string, unknown>): boolean {
  const name = e["event_name"];
  if (e["environment"] === "test") return false;
  if (name === "js_error") return e["error_type"] !== "external";
  if (name === "unhandled_rejection") return e["status"] !== 401 && e["status"] !== 403;
  if (name === "resource_error" || name === "op_timeout") return true;
  if (name === "op_failure") return !["http_4xx", "auth", "offline"].includes(String(e["error_type"]));
  if (name === "request_failed") return e["error_type"] === "http_5xx" || ((e["error_type"] === "network" || e["error_type"] === "timeout") && (e["context"] as { online?: boolean } | undefined)?.online !== false);
  return false;
}
