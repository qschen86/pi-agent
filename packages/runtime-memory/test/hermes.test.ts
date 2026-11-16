import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { HermesMemoryAdapter, diffMemorySnapshots } from '../src/index.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hermes-adapter-')); roots.push(root);
  const file = join(root, 'sessions.db'), db = new DatabaseSync(file);
  // Hermes 0.9.10's durable memory columns. Usage counters are deliberately excluded from knowledge identity.
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, target TEXT NOT NULL,
      category TEXT, content TEXT NOT NULL, failure_reason TEXT, tool_state TEXT, corrected_to TEXT,
      created DATE NOT NULL, last_referenced DATE NOT NULL, hit_count INTEGER DEFAULT 0, last_hit_at DATE);
    CREATE TABLE messages (content TEXT);
    INSERT INTO messages VALUES ('transcript secret must not enter snapshots');
    INSERT INTO memories (project,target,content,created,last_referenced) VALUES
      (NULL,'user','Use Chinese','2026-10-19','2026-10-19'),
      ('alpha','memory','Use SQLite','2026-10-19','2026-10-19'),
      ('beta','memory','Other project secret','2026-10-19','2026-10-19');`);
  const adapter = new HermesMemoryAdapter({ databasePath: file, sourceId: 'pi-instance-one', project: 'alpha' });
  return { root, file, db, adapter };
}
it('reads only durable global/current-project memories from a live WAL without modifying the database', async () => {
  const t = fixture();
  try {
    const before = readFileSync(t.file), wal = readFileSync(t.file + '-wal');
    const snapshot = await t.adapter.readSnapshot();
    expect(snapshot.entries.map((m: any) => m.content)).toEqual(['Use Chinese', 'Use SQLite']);
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    expect(readFileSync(t.file)).toEqual(before); expect(readFileSync(t.file + '-wal')).toEqual(wal);
    const globals = await new HermesMemoryAdapter({ databasePath: t.file, sourceId: 'pi-instance-one', project: null }).readSnapshot();
    expect(globals.entries).toHaveLength(1);
  } finally { t.db.close(); }
});
it('diffs add/update/hard-delete by stable native ID and ignores search usage changes', async () => {
  const t = fixture();
  try {
    const first = await t.adapter.readSnapshot();
    t.db.exec(`UPDATE memories SET hit_count=10,last_referenced='2026-10-20' WHERE id=1`);
    const usage = await t.adapter.readSnapshot();
    expect(usage.hash).toBe(first.hash); expect(t.adapter.getChanges(first, usage)).toEqual([]);
    t.db.exec(`UPDATE memories SET content='Use PostgreSQL' WHERE id=2;
      DELETE FROM memories WHERE id=1;
      INSERT INTO memories (project,target,content,created,last_referenced) VALUES ('alpha','memory','Use Vitest','2026-10-19','2026-10-19')`);
    const next = await t.adapter.readSnapshot(), deltas = t.adapter.getChanges(first, next);
    expect(deltas.map((d: any) => [d.kind, d.id])).toEqual([['delete', '1'], ['update', '2'], ['add', '4']]);
    expect(deltas[0].kind === 'delete' && deltas[0].previous.content).toBe('Use Chinese');
    expect(deltas[1].kind === 'update' && deltas[1].entry.content).toBe('Use PostgreSQL');
    expect(t.adapter.getChanges(next, await t.adapter.readSnapshot())).toEqual([]);
    expect(() => t.adapter.getChanges(first, { ...next, sourceId: 'another-runtime' })).toThrow(/source|scope/);
    expect(() => t.adapter.getChanges(first, { ...next, project: 'beta' })).toThrow(/source|scope/);
    expect(() => t.adapter.getChanges(first, { ...next, hash: 'tampered' })).toThrow(/hash|snapshot/);
  } finally { t.db.close(); }
});
it('does not create a missing database and refuses unknown schemas instead of returning an empty deletion snapshot', async () => {
  const t = fixture(); t.db.close();
  const missing = join(t.root, 'missing.db');
  const adapter = new HermesMemoryAdapter({ databasePath: missing, sourceId: 'pi', project: null });
  expect(await adapter.getHealth()).toMatchObject({ status: 'not-initialized' });
  await expect(adapter.readSnapshot()).rejects.toThrow(); expect(existsSync(missing)).toBe(false);
  const bad = new DatabaseSync(t.file); bad.exec('DROP TABLE memories; CREATE TABLE memories (content TEXT)'); bad.close();
  expect(await t.adapter.getHealth()).toMatchObject({ status: 'unavailable' });
  await expect(t.adapter.readSnapshot()).rejects.toThrow(/schema/);
});
it('rejects an upstream quarantine/rebuild as a database generation change, not mass deletion', async () => {
  const t = fixture();
  const before = await t.adapter.readSnapshot(); t.db.close();
  renameSync(t.file, t.file + '.corrupt-quarantine');
  const rebuilt = new DatabaseSync(t.file);
  rebuilt.exec(`ATTACH DATABASE '${t.file}.corrupt-quarantine' AS old;
    CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, target TEXT NOT NULL,
      category TEXT, content TEXT NOT NULL, failure_reason TEXT, tool_state TEXT, corrected_to TEXT,
      created DATE NOT NULL, last_referenced DATE NOT NULL, hit_count INTEGER DEFAULT 0, last_hit_at DATE)`);
  rebuilt.close();
  const latest = await t.adapter.readSnapshot();
  expect(() => t.adapter.getChanges(before, latest)).toThrow(/generation|identity/);
});

it('isolates scoped snapshots and refuses to diff all versus project even when their entries coincide', async () => {
  const t = fixture();
  try {
    const global = await t.adapter.readSnapshot('global'), project = await t.adapter.readSnapshot('project');
    expect(global.project).toBeNull(); expect(global.entries.map(e => e.id)).toEqual(['1']);
    expect(project.entries.map(e => e.id)).toEqual(['2']);
    const all = await t.adapter.readSnapshot();
    expect(() => diffMemorySnapshots(all, project)).toThrow(/scope/);
    t.db.exec("UPDATE memories SET content='new' WHERE id=2");
    expect(diffMemorySnapshots(project, await t.adapter.readSnapshot('project'))).toMatchObject([{kind:'update', id:'2', previous:{content:'Use SQLite'}, entry:{content:'new'}}]);
    expect(t.adapter.getChanges(global, await t.adapter.readSnapshot('global'))).toEqual([]);
    const noProject = new HermesMemoryAdapter({databasePath:t.file,sourceId:'pi-instance-one',project:null});
    await expect(noProject.readSnapshot('project')).rejects.toThrow(/project/);
  } finally { t.db.close(); }
});

it('reads atomic write origins, preserves unknown legacy sources and includes deletions between captures',async()=>{
 const t=fixture();
 try{
  t.db.exec(`CREATE TABLE runtime_memory_writes(seq INTEGER PRIMARY KEY,event_id TEXT,memory_id TEXT,kind TEXT,origin TEXT,before_entry TEXT,after_entry TEXT)`);
  const old=(await t.adapter.readSnapshot('project')).entries[0];
  const origin={platformSessionId:'rt-one',nativeSessionId:'native',turnId:'turn',provider:'test',model:'model-b',trigger:'shutdown-flush',writtenAt:'2026-10-24T01:00:00Z'};
  const next={...old,content:'changed'};
  const stmt=t.db.prepare('INSERT INTO runtime_memory_writes VALUES(?,?,?,?,?,?,?)');
  stmt.run(1,'a'.repeat(32),'2','update',JSON.stringify(origin),JSON.stringify(old),JSON.stringify(next));
  stmt.run(2,'b'.repeat(32),'2','delete',JSON.stringify(origin),JSON.stringify(next),null);
  t.db.exec('DELETE FROM memories WHERE id=2');
  const snap=await t.adapter.readSnapshot('project');
  expect(t.adapter.listProjects()).toContain('alpha');
  expect(snap.entries).toEqual([]);expect(snap.writes).toHaveLength(2);expect(snap.writes![1]).toMatchObject({kind:'delete',origin,previous:{content:'changed'}});
  expect((await t.adapter.readSnapshot('global')).writes).toEqual([]);
 }finally{t.db.close();}
});

it('does not assign a known writer to memory changed later by an older uninstrumented runtime',async()=>{
 const t=fixture();
 try{
  const before=(await t.adapter.readSnapshot('project')).entries[0],after={...before,content:'audited'};
  const origin={platformSessionId:'rt-audit',nativeSessionId:'native',turnId:'turn',provider:'test',model:'model',trigger:'memory-tool',writtenAt:'2026-10-24T01:00:00Z'};
  t.db.exec('CREATE TABLE runtime_memory_writes(seq INTEGER PRIMARY KEY,event_id TEXT,memory_id TEXT,kind TEXT,origin TEXT,before_entry TEXT,after_entry TEXT)');
  t.db.prepare('INSERT INTO runtime_memory_writes VALUES(?,?,?,?,?,?,?)').run(1,'d'.repeat(32),'2','update',JSON.stringify(origin),JSON.stringify(before),JSON.stringify(after));
  t.db.exec("UPDATE memories SET content='untracked' WHERE id=2");
  const snapshot=await t.adapter.readSnapshot('project');expect(snapshot.entries[0].provenance).toBeUndefined();expect(snapshot.writes).toHaveLength(1);
 }finally{t.db.close();}
});
