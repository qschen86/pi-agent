# Runtime memory read port

Pi uses upstream `pi-hermes-memory@0.9.10`. This package is the platform-owned **read-only** adapter, not another memory engine. It uses Node 24's SQLite reader, never Hermes' database constructor (which can migrate, recover or write).

```ts
import { HermesMemoryAdapter } from '@pi-agent/runtime-memory';
const adapter = new HermesMemoryAdapter({
  databasePath: '/operator/private/pi-memory/data/global/sessions.db',
  sourceId: 'pi-hermes:<store ownership UUID>',
  project: 'pi-agent', // null reads global records only
});
const latest = await adapter.readSnapshot();
const delta = adapter.getChanges(previousSuccessfulSnapshot, latest);
```

The constructor's paths and source identity must come from trusted operator configuration. This is a server-side API, not an arbitrary-path HTTP endpoint. The installed runtime provides the equivalent read port without exposing its profile to the platform:

```sh
/absolute/runtime/bin/pi-runtime --memory-health --cwd /workspace
/absolute/runtime/bin/pi-runtime --memory-snapshot --cwd /workspace --memory-project pi-agent
```

Without `--memory-project`, only global memory is returned. A project read includes global records and that exact Hermes project name. `memories` is the only queried content table; session/message indexes and Markdown exports are excluded. The adapter is not a replacement for access control: only trusted platform code may select a project. Hermes currently identifies projects by repository basename (linked worktrees share their repository's name); separate repositories with the same basename require separate store profiles. It does not provide repository-identity isolation by itself.

Snapshots use a consistent read transaction against the live SQLite database, including committed WAL data. The hash excludes capture time and search usage counters. Native numeric IDs survive normal replacement; hard deletion becomes a `delete` delta carrying the prior record. A merge or consolidation that changes IDs becomes delete/add rather than an invented identity link. Database device/inode/birthtime identity is also included: upstream quarantine/rebuild or file replacement must not become a mass deletion. A changed database generation rejects comparison and requires an explicit checkpoint reset. In-place restoration must use a new ownership UUID or an explicit platform checkpoint reset.

Missing stores report `not-initialized`; corrupt/incompatible/unreadable stores report `unavailable`. Snapshot reads fail in those cases. Reads over 10,000 records or 10 MiB also fail, never truncate: a partial snapshot would incorrectly turn unseen records into deletions. Checkpoints must only advance after the eventual platform consumer durably handles the whole delta; this first step does not yet persist checkpoints, promote knowledge, govern conflicts or hook archive events.

An installed extension is not proof that shutdown extraction succeeded. Hermes defaults to six turns counted within one process; platform workers restart between turns, so this assembly sets `flushMinTurns: 1`. The real-process regression verifies a single-turn automatic extraction after graceful shutdown. Its direct transport remains available; subprocess fallback is explicitly denied through the runtime's guarded Hermes API because upstream children do not carry this runtime's approval gate. A direct failure therefore leaves the store unchanged instead of starting an unmanaged child. Extraction remains internally best-effort: runtime shutdown allows 15 seconds for its 10-second handler budget; the frontend allows 25 seconds for supervisor cleanup. Archive synchronization must eventually distinguish completed/failed/deferred extraction and retry as needed. A forced kill can lose the last flush. Per-turn flush can make one additional request to the session's selected model.

SQLite reads use `readOnly: true` and `query_only`; no memory rows, schema or checkpoints are written. WAL reading can still require SQLite shared-memory sidecars. Under filesystem policies that forbid even sidecar creation and lack readable sidecars, the reader reports unavailable rather than bypassing the policy or silently ignoring the WAL.
