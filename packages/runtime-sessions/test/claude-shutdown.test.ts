import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
it("exits naturally after a Claude result followed by SDK process failure, retaining the exact failed terminal result", async () => {
 const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-failed-result.mts");
 const outcome = await new Promise<{ code: number | null; forced: boolean; output: string; error: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", fixture], { stdio: ["ignore", "pipe", "pipe"] }); let forced = false, output = "", error = "";
  const deadline = setTimeout(() => { forced = true; child.kill("SIGTERM"); }, 5000);
  child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { error += b; }); child.on("error", e => { clearTimeout(deadline); reject(e); }); child.on("close", code => { clearTimeout(deadline); resolve({ code, forced, output, error }); });
 });
 expect(outcome.output).toContain('"terminalObserved":true'); expect(outcome.error).toBe(""); expect(outcome.forced).toBe(false); expect(outcome.code).toBe(0);
}, 10000);
