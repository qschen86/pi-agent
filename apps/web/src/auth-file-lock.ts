import { chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/** OS-managed SQLite write lock: released on process death, with no stale-file unlink race. */
export function withAuthFileLock<T>(file: string, operation: () => T): T {
  const path = `${file}.mutex.sqlite`, db = new DatabaseSync(path);
  let transaction = false;
  try {
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout=2000; BEGIN IMMEDIATE'); transaction = true;
    const result = operation();
    db.exec('COMMIT'); transaction = false;
    return result;
  } finally {
    if (transaction) db.exec('ROLLBACK');
    db.close();
  }
}
