/** 长命令预执行守卫：按命令形状识别“无界递归扫描”，命中就拒绝并给替代写法。启发式防呆，不是沙箱。 */
import { isAbsolute, join, normalize } from 'node:path';

const HOME_EXACT = /^(?:~|\$HOME|\$\{HOME\})\/?$/;
const HOME_DEEP = /^(?:~|\$HOME|\$\{HOME\})\//;
const USER_HOME = /^\/Users\/[^/]+\/?$/;
/** 整盘/系统级起点：扫这些目录一律拒绝。 */
const ROOTISH = new Set(['/', '/Users', '/Volumes', '/System', '/Library', '/Applications', '/opt', '/private', '/usr', '/var', '/etc', '/bin', '/sbin', '/dev', '/cores', '/tmp']);
/** 一次性临时目录不算风险：沙箱 TMPDIR 和 /tmp 下的东西都很小。 */
const TEMP_DIRS = ['/tmp/', '/private/tmp/', '/private/var/folders/'];
/** 明确限时的包装：命中就整条命令放行（本机没有 timeout 命令，实际用 gtimeout 或 perl/python 计时）。 */
const TIMED = /(?:^|[\s;&|(])(?:timeout|gtimeout|gtime)\s+(?:-[\w-]+\s+)*\d|alarm\s*[ (]\s*\d/;
const SCANNERS = new Set(['find', 'gfind', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'du', 'fd', 'fdfind']);
/** 嵌套 shell：bash -c "find …" 这种要钻进去一起看。 */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/** 前置包装命令：跳过它们再找真正的扫描命令。 */
const PREFIX = new Set(['env', 'sudo', 'command', 'nohup', 'nice', 'time', 'exec', 'builtin', 'stdbuf', 'caffeinate', 'xargs']);
const REDIRECT = /^(?:&>|>&|<|\d*>>?)$/;
const MAX_SAFE_DEPTH = 5;
const RECIPE = '改用定点探测（python3 -c "import 模块" / command -v 命令 / mdfind -onlyin <目录> 名字），或把范围收窄到具体子目录';
const ESCAPE = "确实要跑就显式限时：gtimeout 120 … 或 perl -e 'alarm 120; exec @ARGV' …";

/** 按 ; & | 换行切段，同时按引号规则切词；重定向目标不算参数。 */
function segments(command) {
  const out = [];
  let tokens = [], cur = '', quote = '';
  const push = () => { if (cur) { tokens.push(cur); cur = ''; } };
  const save = () => { push(); if (tokens.length) out.push(tokens); tokens = []; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) { quote = ''; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < command.length) { cur += command[++i]; continue; }
      cur += ch; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '\\' && i + 1 < command.length) { cur += command[++i]; continue; }
    if (ch === ';' || ch === '\n' || ch === '&' || ch === '|') {
      save();
      if (ch === '&' && command[i + 1] === '&') i++;
      else if (ch === '|' && (command[i + 1] === '|' || command[i + 1] === '&')) i++;
      continue;
    }
    if (/\s/.test(ch)) { push(); continue; }
    cur += ch;
  }
  save();
  return out.map(stripRedirects);
}

function stripRedirects(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (REDIRECT.test(t)) { i++; continue; }
    if (/^\d*(?:>>?|<<?)\S+$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

/** 跳过变量赋值与前置包装命令，返回实际命令名与参数。 */
function commandOf(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }
    if (PREFIX.has(t)) {
      i++;
      while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
      continue;
    }
    if (t === 'cd') return { name: 'cd', target: tokens[i + 1], rest: tokens.slice(i + 2) };
    break;
  }
  const raw = tokens[i] ?? '';
  return { name: raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw, rest: tokens.slice(i + 1) };
}

function cut(value, max = 90) {
  const flat = String(value).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function classify(raw, ctx) {
  const p = raw === '' ? '.' : raw;
  if (HOME_EXACT.test(p)) return 'root';
  if (HOME_DEEP.test(p)) return 'outside';
  let abs = p;
  if (!isAbsolute(abs)) abs = normalize(join(ctx.cwd, abs));
  abs = abs.replace(/\/+$/, '') || '/';
  if (ROOTISH.has(abs) || USER_HOME.test(abs)) return 'root';
  if (TEMP_DIRS.some((d) => abs === d.slice(0, -1) || abs.startsWith(d))) return 'allowed';
  return ctx.roots.some((root) => abs === root || abs.startsWith(`${root}/`)) ? 'allowed' : 'outside';
}

function rootReason(path) {
  return `SCAN_TOO_BROAD：拒绝对「${cut(path)}」做全盘递归扫描（同类命令曾让一个会话白等 76 分钟，任务其实 6 分钟就做完）。${RECIPE}；${ESCAPE}。`;
}
function outsideReason(command, path) {
  return `SCAN_TOO_BROAD：${command} 的起点「${cut(path)}」在当前工作区之外，而且没有深度上限，很容易扫到几十万文件。加 -maxdepth ${MAX_SAFE_DEPTH}（或更小），或${RECIPE}；${ESCAPE}。`;
}
function grepOutsideReason(command, path) {
  return `SCAN_TOO_BROAD：递归 ${command} 的起点「${cut(path)}」在当前工作区之外。把范围收窄到具体子目录（工作区内不限），或${ESCAPE}。`;
}

const FIND_PREPATH = new Set(['-H', '-L', '-P', '-E', '-X', '-s', '-x', '-d', '-O1', '-O2', '-O3']);

function findShape(args) {
  const paths = [];
  let maxDepth, inExpression = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (FIND_PREPATH.has(t)) continue;
    if (t === '(' || t === '!') { inExpression = true; continue; }
    if (t.startsWith('-')) {
      inExpression = true;
      if (t === '-maxdepth' || t === '--max-depth') { const v = Number(args[i + 1]); if (Number.isFinite(v)) maxDepth = v; i++; }
      else if (t.startsWith('-maxdepth=')) { const v = Number(t.slice('-maxdepth='.length)); if (Number.isFinite(v)) maxDepth = v; }
      continue;
    }
    if (inExpression) continue;
    paths.push(t);
  }
  return { paths: paths.length ? paths : ['.'], maxDepth };
}

function grepShape(args) {
  const VALUE = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-d', '-D', '--include', '--exclude', '--exclude-dir', '--regexp', '--file', '--max-count', '--context', '--after-context', '--before-context', '--label']);
  let recursive = false, pattern = false;
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (VALUE.has(t)) {
      if (t === '-e' || t === '--regexp' || t === '-f' || t === '--file') pattern = true;
      if (t === '-d' && args[i + 1] === 'recurse') recursive = true;
      i++; continue;
    }
    if (t.startsWith('--')) {
      if (t === '--recursive' || t === '--dereference-recursive') recursive = true;
      else if (/^--(?:include|exclude|exclude-dir|regexp|file|max-count|context|after-context|before-context)=/.test(t)) pattern = true;
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      const flags = t.slice(1);
      if (/[rR]/.test(flags)) recursive = true;
      if (/[ef]/.test(flags)) pattern = true;
      if (t.length === 2 && /[efmABCdD]/.test(flags)) i++;
      continue;
    }
    if (!pattern) { pattern = true; continue; }
    paths.push(t);
  }
  return { recursive, paths: paths.length ? paths : ['.'] };
}

function rgShape(args) {
  const VALUE = new Set(['-e', '-f', '-g', '-t', '-T', '-m', '-A', '-B', '-C', '-j', '-E', '--glob', '--iglob', '--type', '--type-not', '--max-count', '--max-depth', '--max-filesize', '--encoding', '--pre', '--sort', '--threads', '--context']);
  let pattern = false, maxDepth;
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (VALUE.has(t)) {
      if (t === '-e' || t === '-f') pattern = true;
      if (t === '--max-depth') { const v = Number(args[i + 1]); if (Number.isFinite(v)) maxDepth = v; }
      i++; continue;
    }
    if (t.startsWith('--max-depth=')) { const v = Number(t.slice('--max-depth='.length)); if (Number.isFinite(v)) maxDepth = v; continue; }
    if (t.startsWith('--')) continue;
    if (t.startsWith('-') && t.length > 1) { if (/[ef]/.test(t.slice(1))) pattern = true; continue; }
    if (!pattern) { pattern = true; continue; }
    paths.push(t);
  }
  return { paths: paths.length ? paths : ['.'], maxDepth };
}

function duShape(args) {
  let bounded = false;
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '-s' || t === '--summarize') { bounded = true; continue; }
    if (t === '-d' || t === '--max-depth') { const v = Number(args[i + 1]); if (Number.isFinite(v) && v <= MAX_SAFE_DEPTH) bounded = true; i++; continue; }
    if (t.startsWith('--max-depth=')) { const v = Number(t.slice('--max-depth='.length)); if (Number.isFinite(v) && v <= MAX_SAFE_DEPTH) bounded = true; continue; }
    if (t.startsWith('-') && t.length > 1) { if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(t)) bounded = true; continue; }
    paths.push(t);
  }
  return { bounded, paths: paths.length ? paths : ['.'] };
}

/**
 * 逐段分析：cd 会更新后续段的工作目录。
 * 返回命中的拒绝原因（中文，含替代写法）；没有命中返回空数组。
 */
export function scanViolations(name, input, options = {}) {
  const command = typeof input === 'string' ? input : typeof input?.command === 'string' ? input.command : typeof input?.cmd === 'string' ? input.cmd : typeof input?.script === 'string' ? input.script : '';
  if (!command) return [];
  // 已显式限时的命令按用户意图放行（限时就是本策略想要的答案）。
  if (TIMED.test(command)) return [];
  const cwd = options.cwd ?? process.cwd();
  const roots = [...new Set([cwd, options.allow, options.repoRoot].filter((v) => typeof v === 'string' && v).map((v) => v.replace(/\/+$/, '') || '/'))];
  const ctx = { cwd, roots };
  const found = [];
  for (const tokens of segments(command)) {
    const { name: cmd, target, rest } = commandOf(tokens);
    if (cmd === 'cd') {
      if (typeof target === 'string' && target && !target.startsWith('-')) ctx.cwd = isAbsolute(target) ? normalize(target) : normalize(join(ctx.cwd, target));
      continue;
    }
    if (SHELLS.has(cmd)) {
      const at = rest.findIndex((t) => /^-[a-z]*c$/.test(t));
      const script = at >= 0 ? rest[at + 1] : undefined;
      if (typeof script === 'string' && script) found.push(...scanViolations(name, { command: script }, options));
      continue;
    }
    if (!SCANNERS.has(cmd)) continue;
    const shape = ['find', 'gfind', 'fd', 'fdfind'].includes(cmd) ? findShape(rest)
      : ['grep', 'egrep', 'fgrep'].includes(cmd) ? grepShape(rest)
      : cmd === 'du' ? duShape(rest) : rgShape(rest);
    const isGrep = ['grep', 'egrep', 'fgrep'].includes(cmd);
    if (isGrep && !shape.recursive) continue;
    for (const path of shape.paths) {
      const where = classify(path, ctx);
      if (where === 'allowed') continue;
      if (where === 'root') { found.push(rootReason(path)); break; }
      if (isGrep) { found.push(grepOutsideReason(cmd, path)); break; }
      if (shape.maxDepth !== undefined && shape.maxDepth <= MAX_SAFE_DEPTH) continue;
      if (cmd === 'du' && shape.bounded) continue;
      found.push(outsideReason(cmd, path));
      break;
    }
  }
  return found;
}

/** 与 screenshotViolation 同一版式：命中返回一条拒绝原因，否则 undefined。 */
export function scanViolation(name, input, options = {}) {
  return scanViolations(name, input, options)[0];
}
