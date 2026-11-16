/**
 * 拉起本机的文件夹选择器，返回用户选中的绝对路径（取消返回 null）。
 *
 * 浏览器拿不到本机绝对路径（<input webkitdirectory> 只给文件内容），所以由本机服务端弹系统自带的对话框：
 * macOS `choose folder`、Windows FolderBrowserDialog、Linux zenity。
 * 提示语与起始目录一律作为参数/环境变量传入，不拼进脚本——不留注入口子；execFile 不经 shell。
 */
import { execFile } from "node:child_process";

export interface PickFolderOptions {
  prompt: string;
  /** 对话框打开时所在的目录（须已存在） */
  startDir: string;
}

export type FolderPicker = (options: PickFolderOptions) => Promise<string | null>;

/** 等人选：给足时间，但不无限挂着 */
const PICK_TIMEOUT_MS = 600_000;

/** 按平台选命令（纯函数，便于测试「参数不进脚本」这条性质）。 */
export function pickFolderCommand(platform: NodeJS.Platform, options: PickFolderOptions): { cmd: string; args: string[]; env?: Record<string, string> } {
  if (platform === "darwin") {
    return {
      cmd: "osascript",
      args: [
        "-e", "on run argv",
        // activate：把对话框提到最前，否则常被浏览器窗口挡在后面
        "-e", "activate",
        "-e", "POSIX path of (choose folder with prompt (item 1 of argv) default location (POSIX file (item 2 of argv)))",
        "-e", "end run",
        options.prompt, options.startDir
      ]
    };
  }
  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$d.Description = $env:PI_PICK_PROMPT",
      "$d.SelectedPath = $env:PI_PICK_START",
      "$d.ShowNewFolderButton = $true",
      "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }"
    ].join("; ");
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-STA", "-Command", script],
      env: { PI_PICK_PROMPT: options.prompt, PI_PICK_START: options.startDir }
    };
  }
  return {
    cmd: "zenity",
    args: ["--file-selection", "--directory", `--title=${options.prompt}`, `--filename=${options.startDir.replace(/\/?$/, "/")}`]
  };
}

export const pickFolderNative: FolderPicker = (options) => {
  const { cmd, args, env } = pickFolderCommand(process.platform, options);
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: PICK_TIMEOUT_MS, ...(env ? { env: { ...process.env, ...env } } : {}) }, (error, stdout, stderr) => {
      const picked = String(stdout).trim();
      if (!error) {
        resolve(picked ? picked.replace(/(.)\/$/, "$1") : null);
        return;
      }
      // 用户点了取消：osascript 报 -128，zenity 退出码 1 且没有输出
      if (/-128|User canceled|用户已取消/i.test(String(stderr)) || ((error as { code?: unknown }).code === 1 && !picked)) {
        resolve(null);
        return;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error(`本机没有可用的文件夹选择器（${cmd}）；请直接输入路径`));
        return;
      }
      reject(new Error(String(stderr).trim() || error.message));
    });
  });
};
