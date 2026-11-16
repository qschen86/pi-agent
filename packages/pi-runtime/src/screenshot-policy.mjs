/** Shared pre-execution policy. Heuristic prevention, not an adversarial code sandbox. */
import {readFileSync, statSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
export const SCREENSHOT_INSTRUCTIONS = `平台浏览器验收：必须使用 platform_browser 工具（MCP 中名为 browser），先 inspect 再交互，可设置 viewport/theme 并 screenshot。禁止为验收临时编写或运行 Playwright/Puppeteer/Selenium/截图脚本，禁止用 shell、文件写入或代码执行绕过。工具不可用时报告原因。项目已有的自动化回归测试可照常执行；页面服务使用项目现有启动命令。汇报截图必须引用工具返回的原始路径与 receiptId；平台会关联真实工具记录并校验文件哈希。`;
const capture = /(?:\.screenshot\s*\(|\[\s*["']screenshot["']\s*\]\s*\(|\bsave_screenshot\s*\(|\bget_screenshot_as_\w+|\bPage\.captureScreenshot\b|\bcapture_screenshot\s*\(|\b(?:playwright|puppeteer)\b[^\n]*\bscreenshot\b|\bscreencapture\b|--screenshot(?:=|\s))/i;
const runner = /\b(?:node|tsx|ts-node|python[\d.]*|bash|sh|zsh|deno|bun)\b([^\n;&|]*)/g;
const regression = /(?:^|\/)(?:test|tests|__tests__|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const regressionCommand = /^\s*(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?::[\w-]+)?|(?:npx\s+)?(?:vitest|playwright\s+test))\b[^;&|`\n]*$/;
export function screenshotViolation(name, input, cwd=process.cwd()) {
  if (/^(?:platform_browser|mcp__platform_browser__browser|platform_browser\.browser)$/.test(name)) return;
  if (/screenshot|capture_screen/i.test(name)) return 'SCREENSHOT_TOOL_REQUIRED：请使用 platform_browser 工具截图。';
  if (!/bash|shell|exec|python|node|write|edit|patch|replace|code|命令|文件修改/i.test(name)) return;
  const value = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  const command = typeof input?.command === 'string' ? input.command : typeof input?.cmd === 'string' ? input.cmd : typeof input === 'string' ? input : '';
  // Only execution of the normal test runner is exempt, never arbitrary content with a test filename.
  if (command && regressionCommand.test(command)) return;
  let blocked = capture.test(value) || /\b(?:node|tsx|python[\d.]*|bash|sh)\b[^\n;&|]*\b[^\s]*?(?:shots|screenshots|screen-capture)[^\s]*\.(?:m?[jt]s|py|sh)\b/i.test(command);
  for (const match of command.matchAll(runner)) {
    const files=match[1].matchAll(/"([^"\n]+\.(?:[cm]?[jt]s|py|sh))"|'([^'\n]+\.(?:[cm]?[jt]s|py|sh))'|([^\s"'=]+\.(?:[cm]?[jt]s|py|sh))\b/g);
    for(const file of files){const path=resolve(cwd,file[1]??file[2]??file[3]);
      try { if (statSync(path).size<=2*1024*1024 && capture.test(readFileSync(path,'utf8'))) blocked=true; } catch { /* missing executable is handled by the runner */ }
    }
  }
  const isTest=(path)=>{const rel=relative(resolve(cwd),resolve(cwd,path));return !rel.startsWith('..')&&!isAbsolute(rel)&&regression.test(rel);};
  // Codex edits through apply_patch rather than Write/Edit. Only patches wholly inside tests qualify.
  const patch=typeof input==='string'?input:input?.command??input?.patch??input?.input??'';
  const targets=typeof patch==='string'?[...patch.matchAll(/\*\*\* (?:(?:Update|Add|Delete) File|Move to):\s*([^\n\r]+)/g)].map(m=>m[1].trim()):[];
  if(/patch/i.test(name)&&targets.length&&targets.every(isTest))return;
  // Editing regression code is permitted only through a direct file edit, with an explicit test target.
  const path = input?.path ?? input?.file_path;
  if (/^(?:write|edit|Write|Edit|MultiEdit)$/.test(name) && typeof path==='string' && isTest(path)) return;
  return blocked ? 'SCREENSHOT_TOOL_REQUIRED：请调用 platform_browser 工具进行截图验收，不得编写或执行临时截图脚本。已有回归测试请使用项目测试命令。' : undefined;
}
