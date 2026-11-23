/** Fixed, read-only CLI inventory. Never runs a shell or reads login credentials. */
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const DEFINITIONS = [
  { id: "gh", label: "GitHub CLI", command: "gh", purpose: "管理 GitHub 仓库、Issue、Pull Request 和发布", pattern: /^gh version (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/m },
  { id: "cloudflared", label: "Cloudflare Tunnel CLI", command: "cloudflared", purpose: "建立和管理 Cloudflare Tunnel，将本机服务连接到公网入口", pattern: /^cloudflared version (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/m }
] as const;

export interface LocalCliResource {
  id: string;
  label: string;
  command: string;
  purpose: string;
  installed: boolean;
  version?: string;
  versionError?: string;
}

export class LocalCliInventory {
  private cached?: { path: string; expires: number; value: Promise<LocalCliResource[]> };

  constructor(private readonly options: { path?: string; timeoutMs?: number; ttlMs?: number } = {}) {}

  read(): Promise<LocalCliResource[]> {
    const path = this.options.path ?? process.env["PATH"] ?? "";
    if (this.cached?.path === path && this.cached.expires > Date.now()) return this.cached.value;
    const value = Promise.all(DEFINITIONS.map(async ({ pattern, ...definition }) => {
      const entry: LocalCliResource = { ...definition, installed: false };
      // Match the server's actual command search path, ignoring cwd-relative entries.
      const executable = path.split(delimiter).filter(isAbsolute).map(dir => join(dir, definition.command)).find(candidate => {
        try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); } catch { return false; }
      });
      if (!executable) return entry;
      entry.installed = true;
      try {
        const { stdout } = await execute(executable, ["--version"], { timeout: this.options.timeoutMs ?? 1500, maxBuffer: 8192, encoding: "utf8", env: { ...process.env, GH_NO_UPDATE_NOTIFIER: "1" } });
        entry.version = pattern.exec(stdout)?.[1];
        if (!entry.version) entry.versionError = "未识别到版本号";
      } catch { entry.versionError = "版本读取失败或超时"; }
      return entry;
    }));
    this.cached = { path, expires: Date.now() + (this.options.ttlMs ?? 30_000), value };
    return value;
  }
}
