/**
 * 从 shell 命令文本里判断它对记忆目录做了什么。纯函数、保守：只认明确的读/搜/写/删动词，
 * 其余（比如 echo 里提到路径）一律忽略，宁可漏记也不误记。
 */
export type ShellOp = 'read' | 'search' | 'write' | 'delete';
export interface ShellAccess { path: string; op: ShellOp; query?: string; lines?: string }

const READ_VERBS = /(?:^|[\s;&|(`'"])(cat|head|tail|sed|awk|nl|less|more|bat|wc|stat|jq|xargs|ls|tree|rg|grep|egrep|fgrep|ag|ack|find|fd|sort|uniq|cut|diff|open)\b/;
const SEARCH_VERBS = /(?:^|[\s;&|(`'"])(rg|grep|egrep|fgrep|ag|ack)\b/;
const DELETE_VERBS = /(?:^|[\s;&|(`'"])(rm|unlink|trash)\b/;
const MOVE_COPY = /(?:^|[\s;&|(`'"])(mv|cp|install)\b/;
const WRITE_VERBS = /(?:^|[\s;&|(`'"])(touch|truncate|tee|dd)\b|(?:^|[\s;&|(`'"])(?:sed|perl)\s+(?:-[A-Za-z]*i\b|-pi)/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 把 ~/、$HOME/、${HOME}/ 展开成绝对路径，便于和 root 比较。 */
export const expandHome = (command: string, home: string): string =>
  command.replace(/(^|[\s'"=(:;])~\//g, `$1${home}/`).replace(/\$\{?HOME\}?\//g, `${home}/`);

function shellWords(command: string): string[] {
  const words: string[] = [];
  const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (let m = re.exec(command); m; m = re.exec(command)) words.push(m[1] ?? (m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]!));
  return words;
}

function searchQuery(words: string[]): string | undefined {
  const i = words.findIndex(w => /^(rg|grep|egrep|fgrep|ag|ack)$/.test(w.replace(/^.*\//, '')));
  if (i < 0) return undefined;
  const optWithValue = new Set(['-g', '--glob', '-t', '--type', '-m', '--max-count', '-A', '-B', '-C', '--max-depth', '-d']);
  for (let j = i + 1; j < words.length; j++) {
    const w = words[j]!;
    if (w === '-e' || w === '--regexp') return words[j + 1];
    if (optWithValue.has(w)) { j++; continue; }
    if (w.startsWith('-')) continue;
    if (/^[|;&]/.test(w)) break;
    return w.length > 200 ? `${w.slice(0, 199)}…` : w;
  }
  return undefined;
}

function lineRange(command: string): string | undefined {
  const sed = /\bsed\s+-n\s+['"]?(\d+)(?:,(\d+))?p/.exec(command);
  if (sed) return sed[2] ? `${sed[1]}–${sed[2]}` : sed[1]!;
  const head = /\bhead\s+(?:-n\s*|-)(\d+)/.exec(command);
  if (head) return `1–${head[1]}`;
  const tail = /\btail\s+(?:-n\s*|-)(\d+)/.exec(command);
  if (tail) return `末 ${tail[1]} 行`;
  return undefined;
}

/** roots：被观察的记忆根目录（绝对路径，无尾斜杠）。返回命令涉及的记忆路径及操作。 */
export function shellMemoryAccess(command: string, roots: readonly string[], home: string): ShellAccess[] {
  if (!command || roots.length === 0) return [];
  // bash -lc "…" / zsh -c '…'：分析里面那一层
  const wrapped = /^\s*(?:\/\S*)?(?:ba|z|da)?sh\s+-[A-Za-z]*c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  const text = expandHome(wrapped ? wrapped[2]! : command, home);
  const found = new Map<string, { index: number }>();
  for (const root of roots) {
    const re = new RegExp(`${escapeRe(root)}(?:/[^\\s'"\`;|&<>()\\\\]*)?`, 'g');
    for (let m = re.exec(text); m; m = re.exec(text)) if (!found.has(m[0])) found.set(m[0], { index: m.index });
  }
  if (!found.size) return [];
  const words = shellWords(text);
  const deleting = DELETE_VERBS.test(text);
  const moving = MOVE_COPY.test(text);
  const writing = WRITE_VERBS.test(text);
  const lastWord = words.filter(w => !w.startsWith('-')).at(-1);
  const out: ShellAccess[] = [];
  for (const [path, { index }] of found) {
    const before = text.slice(Math.max(0, index - 12), index);
    const redirected = /(?:>>?|\btee(?:\s+-\w+)*)\s*['"]?$/.test(before);
    let op: ShellOp | null = null;
    if (redirected) op = 'write';
    else if (deleting) op = 'delete';
    else if (moving) op = path === lastWord ? 'write' : /(?:^|[\s;&|(`'"])mv\b/.test(text) ? 'delete' : 'read';
    else if (writing) op = 'write';
    else if (SEARCH_VERBS.test(text)) op = 'search';
    else if (READ_VERBS.test(text)) op = 'read';
    if (!op) continue;
    const access: ShellAccess = { path, op };
    if (op === 'search') { const q = searchQuery(words); if (q) access.query = q; }
    if (op === 'read') { const l = lineRange(text); if (l) access.lines = l; }
    out.push(access);
  }
  return out;
}
