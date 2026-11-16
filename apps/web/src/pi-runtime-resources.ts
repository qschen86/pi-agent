/** Read-only discovery of the registered standalone Pi assembly. Never executes a launcher. */
import { accessSync, constants, existsSync, realpathSync, statSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { registeredRuntimeExecutable } from "../../../packages/pi-runtime/src/registration.js";
import { PI_TOOL_NAMES } from "../../../packages/pi-runtime/src/policy.js";
import { PI_BROWSER_TOOLS, PI_TEST_TOOLS } from "../../../packages/pi-runtime/src/pi-community-profile.js";
import { HERMES_TOOLS } from "../../../packages/pi-runtime/src/hermes-extension.js";
import type { RuntimeConfigEntry } from "./runtime-configs.js";

export interface PiRuntimeResourceOptions {
  registrationPath?: string;
  executable?: string;
  profilePath?: string;
}
export interface PiRuntimeResources {
  entries: RuntimeConfigEntry[];
  notes: string[];
  state: "ok" | "missing" | "unreadable";
}
const MAX_BYTES = 1_048_576;
function json(path: string): Record<string, unknown> {
  if (statSync(path).size > MAX_BYTES) throw new Error("配置超过读取上限");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("配置格式无效");
  return raw as Record<string, unknown>;
}
function object(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
}

export function scanPiRuntimeResources(home: string, options: PiRuntimeResourceOptions = {}): PiRuntimeResources {
  const result: PiRuntimeResources = { entries: [], notes: [], state: "missing" };
  const add = (kind: RuntimeConfigEntry["kind"], name: string, path: string, source: string, origin: RuntimeConfigEntry["origin"] = "runtime") => {
    result.entries.push({ kind, name, path, source, origin });
  };
  const registration = options.registrationPath || process.env["PI_RUNTIME_REGISTRATION"] || join(home, ".config/pi-runtime/connection.json");
  let executable = options.executable || process.env["PI_AGENT_PI_RUNTIME"];
  try {
    if (!executable) {
      if (!existsSync(registration)) return result;
      add("other", "connection.json", registration, "pi-runtime 注册");
      json(registration); // Bound reads before using the runtime's shared registration validation.
      executable = registeredRuntimeExecutable(registration);
    }
    if (!executable || !isAbsolute(executable)) throw new Error("无效的运行时路径");
    executable = realpathSync(executable);
    if (!statSync(executable).isFile()) throw new Error("运行时路径不是文件");
    accessSync(executable, constants.X_OK);
    add("other", "pi-runtime", executable, "已注册运行时");
    result.state = "ok";
  } catch {
    result.state = "unreadable";
    result.notes.push("pi-runtime connection.json 或运行时路径无效、不可读取或不可执行");
    return result;
  }

  // Managed release: <release>/bin/pi-runtime -> <release>/runtime.mjs.
  // Source installation: packages/pi-runtime/bin/pi-runtime.mjs -> src/cli.ts.
  // Do not guess the assembly of arbitrary custom executables or parse shell/JS wrappers.
  const root = basename(dirname(executable)) === "bin" ? dirname(dirname(executable)) : dirname(executable);
  const managed = existsSync(join(root, "runtime.mjs"));
  const source = basename(executable) === "pi-runtime.mjs" && existsSync(join(root, "src/cli.ts"));
  if (!managed && !source) {
    result.notes.push("已找到运行时，但无法静态识别其装配布局；未推断工具清单");
    return result;
  }
  for (const name of PI_TOOL_NAMES) add("tool", name, executable, "Pi 内置", "builtin");
  const profilePath = options.profilePath || process.env["PI_RUNTIME_PROFILE"] || join(root, source ? "src/profile.json" : "profile.json");
  if (!isAbsolute(profilePath)) {
    result.notes.push("pi-runtime profile.json 必须使用绝对路径，未读取装配");
    return result;
  }
  add("other", basename(profilePath), profilePath, "pi-runtime 装配配置");
  let profile: Record<string, unknown>;
  try {
    profile = json(profilePath);
    if (profile.version !== 1) throw new Error("不支持的版本");
  } catch {
    result.notes.push("pi-runtime profile.json 不存在、不可读取、格式无效或版本不支持；未列出装配工具");
    return result;
  }
  const installed = (path: unknown, name: string, version: string): string | undefined => {
    try {
      if (typeof path !== "string" || !isAbsolute(path)) throw new Error("无效路径");
      const pkg = json(join(path, "package.json"));
      if (pkg.name !== name || pkg.version !== version) throw new Error("不支持的包版本");
      add("extension", `${name}@${version}`, path, "pi-runtime 装配 · profile.json");
      return path;
    } catch {
      result.notes.push(`${name} 安装路径缺失、不可读取或版本不匹配；未列出该包的工具`);
      return undefined;
    }
  };
  if (!installed(profile.permissionPackage, "@gotgenes/pi-permission-system", "40.2.2")) {
    result.notes.push("权限扩展不可用，无法确认 pi-ask 装配工具");
    return result;
  }
  add("tool", "bash_escalated", executable, "pi-runtime 装配 · 权限执行");
  for (const [key, name, version, tools, server] of [
    ["browser", "@playwright/mcp", "0.0.83", PI_BROWSER_TOOLS, "playwright"],
    ["testing", "@playwright/test", "1.63.0", PI_TEST_TOOLS, "playwright_test"],
    ["memory", "pi-hermes-memory", "0.9.10", HERMES_TOOLS, undefined]
  ] as const) {
    if (profile[key] === undefined) continue;
    const path = installed(object(profile[key])?.packageRoot, name, version);
    if (!path) continue;
    if (server) add("mcp", server, path, "pi-runtime 装配 · profile.json");
    for (const tool of tools) add("tool", tool, path, `pi-runtime 装配 · ${name}`);
  }
  return result;
}
