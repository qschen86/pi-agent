import type { EntryRef, RelationNode } from "./note-relation-types.js";
/**
 * Google 日历只读接入。
 *
 * 平台只做两件事：
 *   1. 用 OAuth 授权码 + PKCE 拿到只读令牌；
 *   2. 读取用户在设置里指定的日历事件，交给平台日历展示。
 *
 * 不调用 events.insert / update / delete，也不写入 Google Tasks。令牌与 client secret
 * 存在数据目录的 0600 JSON 文件里，接口只返回状态，不回显密钥。
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CalendarEvent } from "./calendar.js";
import { fetchIcsFeed, isIcloudPublishedUrl, normalizeSharedCalendarUrl, parseIcsCalendar } from "./ics-calendar.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const CALENDAR_LIST_ENDPOINT = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const CALENDAR_EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars";
/** 只申请读取：事件 + 日历列表。没有 events 写入权限。 */
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
] as const;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_STATE_TTL_MS = 10 * 60_000;
const MAX_CALENDARS = 20;
const MAX_EVENTS_PER_CALENDAR = 2500;
const MAX_PAGES = 5;

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  tokenType?: string;
}

interface StoredSettings {
  version: 1;
  clientId?: string;
  clientSecret?: string;
  calendarIds: string[];
  /** 公开分享的 Google 日历（已归一化为公开 ICS 地址）；不需要 OAuth */
  sharedUrls: string[];
  tokens?: StoredTokens;
  connectedAt?: string;
  lastSyncAt?: string;
  lastError?: string;
}

interface PendingAuthorization {
  redirectUri: string;
  codeVerifier: string;
  expiresAt: number;
}

export interface GoogleCalendarStatus {
  /** 是否已配置 OAuth client（ID + secret） */
  clientConfigured: boolean;
  clientSource: "env" | "file" | "none";
  /** OAuth Client ID 不是密钥，回显给设置表单；secret 永不返回 */
  clientId?: string;
  /** 是否已有可用的 refresh token */
  connected: boolean;
  calendarIds: string[];
  /** 分享日历的 ICS 地址（公开地址或秘密 iCal） */
  sharedUrls: string[];
  connectedAt?: string;
  lastSyncAt?: string;
  lastError?: string;
}

export interface GoogleCalendarSummary {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole?: string;
  backgroundColor?: string;
}

export interface GoogleCalendarEventsResult {
  events: CalendarEvent[];
  errors: string[];
  status: GoogleCalendarStatus;
  cached: boolean;
}

export interface GoogleCalendarOptions {
  /** 数据目录；设置与令牌存为 google-calendar.json */
  dir: string;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
  cacheTtlMs?: number;
  stateTtlMs?: number;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
}

class GoogleApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function text(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function httpUrl(value: unknown): string | undefined {
  const url = text(value, 1000);
  return /^https?:\/\//i.test(url) ? url : undefined;
}

function isStoredTokens(value: unknown): value is StoredTokens {
  const t = value as Partial<StoredTokens> | null;
  return !!t && typeof t === "object" && typeof t.accessToken === "string" && t.accessToken.length > 0
    && typeof t.expiresAt === "number" && Number.isFinite(t.expiresAt)
    && (t.refreshToken === undefined || typeof t.refreshToken === "string")
    && (t.scope === undefined || typeof t.scope === "string")
    && (t.tokenType === undefined || typeof t.tokenType === "string");
}

function normalizeCalendarIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\n,]+/) : [];
  const ids = raw.map((item) => text(item, 500)).filter(Boolean).map(normalizeCalendarId);
  const unique = [...new Set(ids)];
  if (unique.length > MAX_CALENDARS) throw new Error(`最多指定 ${MAX_CALENDARS} 个 Google 日历`);
  return unique;
}

/** 公开分享地址 → 公开 ICS 地址；不需要 OAuth。 */
function normalizeSharedUrls(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\n+/) : [];
  const urls = raw.map((item) => text(item, 4000)).filter(Boolean).map((item) => normalizeSharedCalendarUrl(item).icsUrl);
  const unique = [...new Set(urls)];
  if (unique.length > MAX_CALENDARS) throw new Error(`最多指定 ${MAX_CALENDARS} 个分享日历`);
  return unique;
}

/** 从 ICS 地址里取一个安全的展示名，避免把秘密地址（含 token）显示在错误里。 */
function sharedCalendarDisplayId(url: string): string {
  try {
    const parsed = new URL(url);
    if (isIcloudPublishedUrl(url)) return "iCloud 日历";
    const match = /\/calendar\/ical\/([^/]+)\//.exec(parsed.pathname);
    if (match?.[1]) return decodeURIComponent(match[1]);
    return parsed.hostname;
  } catch { /* 继续用兜底名 */ }
  return "日历";
}

/** 事件的来源 ID：iCloud 用地址哈希，避免把秘密路径带进页面。 */
function sharedCalendarEventId(url: string): string {
  try {
    if (isIcloudPublishedUrl(url)) return `icloud:${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
    const match = /\/calendar\/ical\/([^/]+)\//.exec(new URL(url).pathname);
    if (match?.[1]) return decodeURIComponent(match[1]);
    return new URL(url).hostname;
  } catch { return "calendar"; }
}

/** 接受 Google 日历 ID，也接受常见的日历链接（cid / src / ical 地址）。 */
export function normalizeCalendarId(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("Google 日历 ID 不能为空");
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`无法识别的日历地址：${value.slice(0, 80)}`); }
    const cid = url.searchParams.get("cid");
    if (cid) {
      try {
        const decoded = Buffer.from(cid.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").trim();
        if (decoded) return decoded;
      } catch { /* 继续尝试 src / ical */ }
    }
    const src = url.searchParams.get("src");
    if (src) return decodeURIComponent(src).trim();
    const ical = /\/calendar\/ical\/([^/]+)\//.exec(url.pathname);
    if (ical?.[1]) return decodeURIComponent(ical[1]).trim();
    throw new Error("请填写 Google 日历 ID（例如 primary 或 xxx@group.calendar.google.com），不要填网页地址");
  }
  if (/[\s\x00-\x1f]/.test(value)) throw new Error("Google 日历 ID 不能包含空白或控制字符");
  return value;
}

function googleErrorMessage(body: unknown, status: number): string {
  const b = body as { error?: { message?: unknown; status?: unknown } | string; message?: unknown; error_description?: unknown } | null;
  const description = text(b?.error_description, 300);
  if (description) return description;
  const message = typeof b?.error === "object" ? text(b.error.message, 300) : typeof b?.error === "string" ? text(b.error, 300) : text(b?.message, 300);
  if (message) return message;
  if (status === 401) return "Google 授权已过期，请重新连接";
  if (status === 403) return "没有读取该 Google 日历的权限";
  if (status === 404) return "找不到这个 Google 日历";
  if (status === 429) return "Google 日历请求过于频繁，请稍后再试";
  return `Google 日历返回 HTTP ${status}`;
}

export class GoogleCalendarService {
  private readonly file: string;
  private readonly relationCache=new Map<string,{at:number;node:RelationNode}>();
  private readonly fetchImpl: typeof fetch;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly stateTtlMs: number;
  private readonly pending = new Map<string, PendingAuthorization>();
  private data: StoredSettings;
  private cache?: { key: string; at: number; events: CalendarEvent[]; errors: string[]; status: GoogleCalendarStatus };
  private refreshFlight?: Promise<string>;

  constructor(options: GoogleCalendarOptions) {
    this.file = join(options.dir, "google-calendar.json");
    this.fetchImpl = options.fetch ?? fetch;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.stateTtlMs = options.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    this.data = this.load();
  }

  relationAccountId(calendarId?:string):string {
    const shared=calendarId?this.selectedSharedUrls().find(u=>sharedCalendarEventId(u)===calendarId):undefined;
    const identity=shared?['shared',shared]:['google',this.data.clientId??this.client()?.id??'',this.data.connectedAt??null];
    return (shared?'gs-':'gc-')+createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,24);
  }
  relationRef(event:CalendarEvent):Extract<EntryRef,{kind:'google'}> {
    const shared=this.selectedSharedUrls().some(u=>sharedCalendarEventId(u)===event.calendarId),ics=shared?event.id.match(/^(.*):[0-9]+:(-?[0-9]+)$/):null;
    const stableId=ics&&ics[1]!=='ics'?ics[1]+':'+ics[2]:event.id;
    return {kind:'google',accountId:this.relationAccountId(event.calendarId),calendarId:event.calendarId??'',eventId:event.recurringEventId??stableId,...(event.recurringEventId?{seriesId:event.recurringEventId}:{})};
  }
  relationAuthorized(ref:EntryRef):boolean {return ref.kind==='google'&&ref.accountId===this.relationAccountId(ref.calendarId)&&((!!this.data.tokens?.refreshToken&&this.selectedCalendarIds().includes(ref.calendarId))||this.selectedSharedUrls().some(u=>sharedCalendarEventId(u)===ref.calendarId));}
  async resolveRelationEntry(ref:EntryRef):Promise<RelationNode>{
    const unavailable:RelationNode={ref,state:"unavailable",relationCount:0,checkedAt:new Date(this.now()).toISOString()};
    if(ref.kind!=="google"||!this.relationAuthorized(ref))return {ref,state:"unavailable",relationCount:0};
    const key=JSON.stringify(ref),cached=this.relationCache.get(key);if(cached&&this.now()-cached.at<this.cacheTtlMs)return structuredClone(cached.node);
    const shared=this.selectedSharedUrls().find(u=>sharedCalendarEventId(u)===ref.calendarId);
    let event:CalendarEvent|undefined;
    if(shared){
      const matches=(e:CalendarEvent)=>e.calendarId===ref.calendarId&&(e.id===ref.eventId||this.relationRef(e).eventId===ref.eventId);
      event=this.cache?.events.find(matches);
      if(!event){const raw=await fetchIcsFeed(this.fetchImpl,shared),stamp=Number(ref.eventId.split(':').at(-1));
        const explicit=Number.isFinite(stamp)&&Math.abs(stamp)<8.63e15&&/:-?[0-9]+$/.test(ref.eventId);
        const from=explicit?stamp-2*86400000:this.now()-366*86400000,to=explicit?stamp+2*86400000:this.now()+2*366*86400000;
        event=parseIcsCalendar(raw,{from:new Date(from).toISOString(),to:new Date(to).toISOString(),calendarId:ref.calendarId}).find(matches);
      }
    }
    else{
      const token=await this.accessToken();const res=await this.fetchImpl(`${CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(ref.calendarId)}/events/${encodeURIComponent(ref.eventId)}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
      if([401,403,404,410].includes(res.status)){this.relationCache.set(key,{at:this.now(),node:unavailable});return unavailable;}
      if(!res.ok)throw new Error(`日程读取失败（${res.status}）`);
      const item=await res.json() as {id?:string;summary?:string;status?:string;recurringEventId?:string;recurrence?:unknown[];start?:{dateTime?:string;date?:string};end?:{dateTime?:string;date?:string}};
      if(item.status==="cancelled"||item.id!==ref.eventId||ref.seriesId&&ref.seriesId!==item.recurringEventId&&!(item.id===ref.seriesId&&Array.isArray(item.recurrence)))return unavailable;
      event={id:item.id,source:"google",calendarId:ref.calendarId,title:typeof item.summary==="string"?item.summary.slice(0,300):"（无标题）",start:item.start?.dateTime??item.start?.date??"",end:item.end?.dateTime??item.end?.date??"",...(item.recurringEventId?{recurringEventId:item.recurringEventId}:{}),...(ref.seriesId?{recurringEventId:ref.seriesId}:{})};
    }
    const node:RelationNode=event?{ref:this.relationRef(event),state:"available",title:event.title,displayKind:"event",relationCount:0,checkedAt:new Date(this.now()).toISOString()}:unavailable;
    this.relationCache.set(key,{at:this.now(),node});return structuredClone(node);
  }

  private load(): StoredSettings {
    if (!existsSync(this.file)) return { version: 1, calendarIds: [], sharedUrls: [] };
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoredSettings> | null;
      const calendarIds = Array.isArray(raw?.calendarIds) ? raw.calendarIds.filter((id): id is string => typeof id === "string" && !!id.trim()).slice(0, MAX_CALENDARS) : [];
      const sharedUrls = Array.isArray(raw?.sharedUrls) ? raw.sharedUrls.filter((url): url is string => typeof url === "string" && !!url.trim()).slice(0, MAX_CALENDARS) : [];
      return {
        version: 1,
        ...(typeof raw?.clientId === "string" && raw.clientId.trim() ? { clientId: raw.clientId.trim().slice(0, 500) } : {}),
        ...(typeof raw?.clientSecret === "string" && raw.clientSecret.trim() ? { clientSecret: raw.clientSecret.trim().slice(0, 1000) } : {}),
        calendarIds,
        sharedUrls,
        ...(isStoredTokens(raw?.tokens) ? { tokens: { ...raw.tokens } } : {}),
        ...(typeof raw?.connectedAt === "string" ? { connectedAt: raw.connectedAt } : {}),
        ...(typeof raw?.lastSyncAt === "string" ? { lastSyncAt: raw.lastSyncAt } : {}),
        ...(typeof raw?.lastError === "string" && raw.lastError ? { lastError: raw.lastError.slice(0, 500) } : {})
      };
    } catch {
      // 文件损坏时宁可要求重新配置，也不让整个控制台打不开。
      return { version: 1, calendarIds: [], sharedUrls: [] };
    }
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private client(): { id: string; secret: string; source: "env" | "file" } | undefined {
    const envId = text(this.env["GOOGLE_CALENDAR_CLIENT_ID"], 500);
    const envSecret = text(this.env["GOOGLE_CALENDAR_CLIENT_SECRET"], 1000);
    if (envId && envSecret) return { id: envId, secret: envSecret, source: "env" };
    if (this.data.clientId && this.data.clientSecret) return { id: this.data.clientId, secret: this.data.clientSecret, source: "file" };
    return undefined;
  }

  private selectedCalendarIds(): string[] {
    if (this.data.calendarIds.length) return [...this.data.calendarIds];
    const value = this.env["GOOGLE_CALENDAR_IDS"];
    if (!value) return [];
    try { return normalizeCalendarIds(value); } catch { return []; }
  }

  private selectedSharedUrls(): string[] {
    if (this.data.sharedUrls.length) return [...this.data.sharedUrls];
    const value = this.env["GOOGLE_CALENDAR_SHARED_URLS"];
    if (!value) return [];
    try { return normalizeSharedUrls(value); } catch { return []; }
  }

  status(): GoogleCalendarStatus {
    const client = this.client();
    const calendarIds = this.selectedCalendarIds();
    const sharedUrls = this.selectedSharedUrls();
    return {
      clientConfigured: !!client,
      clientSource: client?.source ?? "none",
      ...(client?.id ? { clientId: client.id } : {}),
      connected: !!client && !!this.data.tokens?.refreshToken,
      calendarIds,
      sharedUrls,
      ...(this.data.connectedAt ? { connectedAt: this.data.connectedAt } : {}),
      ...(this.data.lastSyncAt ? { lastSyncAt: this.data.lastSyncAt } : {}),
      ...(this.data.lastError ? { lastError: this.data.lastError } : {})
    };
  }

  /** 保存 OAuth client、日历 ID。clientSecret 传空字符串表示保持原值；传 null 表示清除。 */
  configure(input: { clientId?: unknown; clientSecret?: unknown; calendarIds?: unknown; sharedUrls?: unknown }): GoogleCalendarStatus {
    const before = this.client();
    if (input.clientId !== undefined) {
      if (input.clientId === null) delete this.data.clientId;
      else if (typeof input.clientId !== "string") throw new Error("Client ID 必须是文字");
      else if (input.clientId.trim()) this.data.clientId = input.clientId.trim().slice(0, 500);
    }
    if (input.clientSecret !== undefined) {
      if (input.clientSecret === null) delete this.data.clientSecret;
      else if (typeof input.clientSecret !== "string") throw new Error("Client Secret 必须是文字");
      else if (input.clientSecret.trim()) this.data.clientSecret = input.clientSecret.trim().slice(0, 1000);
    }
    if (input.calendarIds !== undefined) {
      if (typeof input.calendarIds !== "string" && !Array.isArray(input.calendarIds)) throw new Error("日历列表格式不正确");
      this.data.calendarIds = normalizeCalendarIds(input.calendarIds);
    }
    if (input.sharedUrls !== undefined) {
      if (typeof input.sharedUrls !== "string" && !Array.isArray(input.sharedUrls)) throw new Error("分享日历列表格式不正确");
      this.data.sharedUrls = normalizeSharedUrls(input.sharedUrls);
    }
    const after = this.client();
    // client 变了，旧令牌不再可信；清掉让用户重新授权，避免拿错 client 的 refresh token。
    if (before?.id !== after?.id || before?.secret !== after?.secret) {
      delete this.data.tokens;
      delete this.data.connectedAt;
      delete this.data.lastSyncAt;
      delete this.data.lastError;
      this.cache = undefined;
    }
    this.save();
    return this.status();
  }

  /** 授权码 + PKCE 的 Google 授权地址。redirectUri 由调用方按允许的域名生成。 */
  authorizationUrl(redirectUri: string): string {
    const client = this.client();
    if (!client) throw new Error("还没有配置 Google OAuth Client ID / Secret");
    const uri = new URL(redirectUri);
    if (!/^https?:$/.test(uri.protocol) || uri.hash) throw new Error("OAuth 回调地址不合法");
    this.pruneStates();
    const state = randomBytes(24).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    this.pending.set(state, { redirectUri: uri.toString(), codeVerifier, expiresAt: this.now() + this.stateTtlMs });
    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set("client_id", client.id);
    url.searchParams.set("redirect_uri", uri.toString());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_CALENDAR_SCOPES.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  private pruneStates(): void {
    const now = this.now();
    for (const [state, pending] of this.pending) if (pending.expiresAt <= now) this.pending.delete(state);
  }

  /** 回调：校验一次性 state，用 code + verifier 换令牌。 */
  async completeAuthorization(code: string, state: string): Promise<GoogleCalendarStatus> {
    this.pruneStates();
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending) throw new Error("授权状态已失效，请重新连接 Google 日历");
    if (pending.expiresAt <= this.now()) throw new Error("授权已超时，请重新连接 Google 日历");
    const client = this.client();
    if (!client) throw new Error("还没有配置 Google OAuth Client ID / Secret");
    if (!code.trim()) throw new Error("Google 没有返回授权码");
    const tokens = await this.tokenRequest({
      grant_type: "authorization_code",
      code: code.trim(),
      client_id: client.id,
      client_secret: client.secret,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.codeVerifier
    });
    if (!tokens.refreshToken) throw new Error("Google 没有返回 refresh token，请重新授权并同意离线访问");
    this.data.tokens = tokens;
    this.data.connectedAt = new Date(this.now()).toISOString();
    delete this.data.lastError;
    this.save();
    this.cache = undefined;
    return this.status();
  }

  async disconnect(): Promise<GoogleCalendarStatus> {
    delete this.data.tokens;
    delete this.data.connectedAt;
    delete this.data.lastSyncAt;
    delete this.data.lastError;
    this.save();
    this.cache = undefined;
    return this.status();
  }

  private async tokenRequest(params: Record<string, string>): Promise<StoredTokens> {
    const response = await this.fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000)
    });
    const body = await response.json().catch(() => undefined) as TokenResponse | undefined;
    if (!response.ok) throw new Error(googleErrorMessage(body, response.status));
    const accessToken = text(body?.access_token, 4000);
    if (!accessToken) throw new Error("Google 令牌响应缺少 access_token");
    const expiresIn = Number(body?.expires_in);
    return {
      accessToken,
      expiresAt: this.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3600_000),
      ...(text(body?.refresh_token, 4000) ? { refreshToken: text(body?.refresh_token, 4000) } : {}),
      ...(text(body?.scope, 1000) ? { scope: text(body?.scope, 1000) } : {}),
      ...(text(body?.token_type, 100) ? { tokenType: text(body?.token_type, 100) } : {})
    };
  }

  /** 取可用 access token；过期前 60 秒主动刷新。并发刷新合并成一个请求。 */
  private async accessToken(): Promise<string> {
    const tokens = this.data.tokens;
    if (!tokens?.refreshToken) throw new Error("还没有连接 Google 日历");
    if (tokens.accessToken && tokens.expiresAt > this.now() + 60_000) return tokens.accessToken;
    if (this.refreshFlight) return this.refreshFlight;
    const client = this.client();
    if (!client) throw new Error("还没有配置 Google OAuth Client ID / Secret");
    this.refreshFlight = (async () => {
      const refreshed = await this.tokenRequest({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken!,
        client_id: client.id,
        client_secret: client.secret
      });
      this.data.tokens = {
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? tokens.refreshToken
      };
      this.save();
      return this.data.tokens.accessToken;
    })().finally(() => { this.refreshFlight = undefined; });
    return this.refreshFlight;
  }

  private async googleJson(url: string): Promise<unknown> {
    let token = await this.accessToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(12_000)
      });
      const body = await response.json().catch(() => undefined);
      if (response.status === 401 && attempt === 0) {
        // 令牌被服务端判定失效：强制刷新后重试一次；refresh token 也失效时让调用方提示重新授权。
        if (this.data.tokens) this.data.tokens = { ...this.data.tokens, accessToken: "", expiresAt: 0 };
        token = await this.accessToken();
        continue;
      }
      if (!response.ok) throw new GoogleApiError(googleErrorMessage(body, response.status), response.status);
      return body;
    }
    throw new GoogleApiError("Google 授权已过期，请重新连接", 401);
  }

  /** 读取用户可访问的日历列表，供页面勾选。 */
  async calendars(): Promise<GoogleCalendarSummary[]> {
    const body = await this.googleJson(`${CALENDAR_LIST_ENDPOINT}?minAccessRole=reader&maxResults=250`) as {
      items?: Array<{ id?: unknown; summary?: unknown; primary?: unknown; accessRole?: unknown; backgroundColor?: unknown }>;
    } | undefined;
    const items = Array.isArray(body?.items) ? body.items : [];
    return items.flatMap((item) => {
      const id = text(item.id, 500);
      if (!id) return [];
      return [{
        id,
        summary: text(item.summary, 200) || id,
        ...(item.primary === true ? { primary: true } : {}),
        ...(text(item.accessRole, 50) ? { accessRole: text(item.accessRole, 50) } : {}),
        ...(text(item.backgroundColor, 50) ? { backgroundColor: text(item.backgroundColor, 50) } : {})
      }];
    });
  }

  /**
   * 拉取指定日历在 [from, to) 内的事件。只读；失败时返回缓存（若有）和可读错误。
   */
  async events(from: string, to: string, options: { force?: boolean } = {}): Promise<GoogleCalendarEventsResult> {
    const fromTime = Date.parse(from), toTime = Date.parse(to);
    if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) throw new Error("日历时间范围不合法");
    if (toTime <= fromTime) throw new Error("日历结束时间必须晚于开始时间");
    const fromIso = new Date(fromTime).toISOString();
    const toIso = new Date(toTime).toISOString();
    const calendarIds = this.selectedCalendarIds();
    const sharedUrls = this.selectedSharedUrls();
    const key = `${fromIso}|${toIso}|${calendarIds.join(",")}|${sharedUrls.join(",")}`;
    if (!options.force && this.cache?.key === key && this.now() - this.cache.at < this.cacheTtlMs) {
      return { events: this.cache.events, errors: this.cache.errors, status: this.status(), cached: true };
    }
    const oauthReady = !!this.data.tokens?.refreshToken && !!this.client() && calendarIds.length > 0;
    if (!oauthReady && !sharedUrls.length) {
      return { events: [], errors: [], status: this.status(), cached: false };
    }
    const events: CalendarEvent[] = [];
    const errors: string[] = [];
    // OAuth 私有日历与公开分享日历并行读：公开日历不需要 OAuth。
    const tasks: Array<Promise<{ source: string; events?: CalendarEvent[]; error?: string }>> = [];
    if (oauthReady) {
      for (const calendarId of calendarIds) {
        tasks.push((async () => {
          try { return { source: calendarId, events: await this.fetchCalendarEvents(calendarId, fromIso, toIso) }; }
          catch (e) { return { source: calendarId, error: (e as Error).message }; }
        })());
      }
    }
    for (const url of sharedUrls) {
      const source = sharedCalendarDisplayId(url);
      const calendarId = sharedCalendarEventId(url);
      tasks.push((async () => {
        try {
          const text = await fetchIcsFeed(this.fetchImpl, url);
          return { source, events: parseIcsCalendar(text, { from: fromIso, to: toIso, calendarId }) };
        } catch (e) {
          return { source, error: (e as Error).message };
        }
      })());
    }
    const results = await Promise.all(tasks);
    for (const result of results) {
      if (result.events) events.push(...result.events);
      else errors.push(`${result.source}：${result.error}`);
    }
    events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    this.data.lastSyncAt = new Date(this.now()).toISOString();
    if (errors.length) this.data.lastError = errors.join("；").slice(0, 500);
    else delete this.data.lastError;
    this.save();
    this.cache = { key, at: this.now(), events, errors, status: this.status() };
    return { events, errors, status: this.status(), cached: false };
  }

  private async fetchCalendarEvents(calendarId: string, fromIso: string, toIso: string): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];
    let pageToken = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(`${CALENDAR_EVENTS_ENDPOINT}/${encodeURIComponent(calendarId)}/events`);
      url.searchParams.set("timeMin", fromIso);
      url.searchParams.set("timeMax", toIso);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("showDeleted", "false");
      url.searchParams.set("maxResults", String(MAX_EVENTS_PER_CALENDAR));
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const body = await this.googleJson(url.toString()) as {
        items?: Array<{
          id?: unknown; summary?: unknown; status?: unknown; htmlLink?: unknown; location?: unknown; description?: unknown; recurringEventId?: unknown;
          start?: { date?: unknown; dateTime?: unknown };
          end?: { date?: unknown; dateTime?: unknown };
        }>;
        nextPageToken?: unknown;
      } | undefined;
      const items = Array.isArray(body?.items) ? body.items : [];
      for (const item of items) {
        if (text(item.status, 20) === "cancelled") continue;
        const id = text(item.id, 500);
        const start = text(item.start?.dateTime, 100) || text(item.start?.date, 20);
        const end = text(item.end?.dateTime, 100) || text(item.end?.date, 20);
        if (!id || !start || !end) continue;
        const allDay = !item.start?.dateTime && !!item.start?.date;
        const htmlLink = httpUrl(item.htmlLink);
        events.push({
          id,
          source: "google",
          title: text(item.summary, 300) || "（无标题）",
          start,
          end,
          ...(allDay ? { allDay: true } : {}),
          calendarId,
          ...(text(item.recurringEventId,500)?{recurringEventId:text(item.recurringEventId,500)}:{}),
          ...(htmlLink ? { htmlLink } : {}),
          ...(text(item.location, 500) ? { location: text(item.location, 500) } : {}),
          ...(text(item.description, 4000) ? { description: text(item.description, 4000) } : {})
        });
      }
      const next = text(body?.nextPageToken, 500);
      if (!next || items.length < MAX_EVENTS_PER_CALENDAR) break;
      pageToken = next;
    }
    return events;
  }
}
