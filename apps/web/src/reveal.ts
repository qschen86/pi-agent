/**
 * 在系统文件管理器里「显示」一个文件或目录：打开它所在的文件夹，并选中它。
 *
 * 只显示、绝不「打开」：交付物是模型写出来的，可能是任何东西——
 * `open <文件>` 等于用默认程序打开它，`.command`、`.app` 会被直接运行。
 * 所以 macOS 一律 `open -R`（在访达中显示），目录也不例外（`open Evil.app` 会启动它）。
 * 一律 execFile 传 argv、不经 shell。
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { dirname } from "node:path";

/** 按平台选命令（纯函数，便于测试"只显示不打开"这条性质）。 */
export function revealCommand(platform: NodeJS.Platform, absPath: string, isDirectory: boolean): [string, string[]] {
  if (platform === "darwin") return ["open", ["-R", absPath]];
  if (platform === "win32") return ["explorer.exe", [`/select,${absPath}`]];
  // 其它平台没有统一的「显示并选中」：只打开所在目录（目录本身则打开它）
  return ["xdg-open", [isDirectory ? absPath : dirname(absPath)]];
}

export function revealInFileManager(absPath: string): Promise<void> {
  const [cmd, args] = revealCommand(process.platform, absPath, statSync(absPath).isDirectory());
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000 }, (error) => {
      // explorer.exe 成功时也常以退出码 1 结束；只有根本启动不了才算失败
      if (error && (process.platform !== "win32" || (error as NodeJS.ErrnoException).code === "ENOENT")) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
