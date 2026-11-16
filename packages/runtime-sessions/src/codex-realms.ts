/** Host-owned original-ID authority. Native state is writable; this registry never is. */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { canonicalPath, isWithin } from "@pi-agent/adapter-pi";
import { normalizeEvaluation, type EvaluationBoundary } from "./evaluation.js";
import { validCodexStock, type CodexStockManifest } from "./codex-stock.js";
import { withHostMutex } from "./host-mutex.js";
export interface CodexRealmSpec {
    workspace: string;
    evaluation: EvaluationBoundary;
    sourceHash: string;
}
interface Spec {
    workspace: string;
    reportDir: string;
    inputRoots: string[];
    sourceHash: string;
}
interface Creation {phase: "preparing" | "ready" | "dispatched"; claimId: string;}
interface RecordEntry {
    creation?: Creation;
    stock?: CodexStockManifest;
    platformSessionId: string;
    realmId: string;
    attemptId: string;
    spec: Spec;
    specHash: string;
    nativeSessionId?: string;
}
interface Authority {
    version: 1;
    root: string;
    realms: Record<string, RecordEntry>;
}
export interface CodexRealm {
    creationClaimId?: string;
    spec: CodexRealmSpec;
    platformSessionId: string;
    realmId: string;
    attemptId: string;
    expectedHash: string;
    runtimeRoot: string;
    codexHome: string;
    nativeSessionId?: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = /^sha256:[a-f0-9]{64}$/;
const hash = (value: unknown) => "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);
function fail(code: string, message: string): never {
    throw Object.assign(new Error(message), {
        code
    });
}
const corrupt = (message: string): never => fail("RT_CODEX_REALM_CORRUPT", message);
function exact(value: unknown, keys: string[]): boolean {
    return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys.sort().join(",");
}
function directory(path: string, create = false): void {
    if (create)
        mkdirSync(path, {
            recursive: true, mode: 0o700
        });
    try {
        const s = lstatSync(path);
        if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(path) !== path)
            corrupt("Codex realm state/authority directory is linked or changed");
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            corrupt("Codex realm state/authority directory is missing; cannot recreate native state");
        throw error;
    }
}
function normalized(spec: CodexRealmSpec): Spec {
    if (!spec || !sha.test(spec.sourceHash))
        throw new Error("Codex realm source identity is required");
    const e = normalizeEvaluation(spec.workspace, spec.evaluation);
    return {
        workspace: canonicalPath(spec.workspace), reportDir: e.reportDir, inputRoots: [...e.inputRoots].sort(), sourceHash: spec.sourceHash
    };
}
function publish(file: string, value: Authority): void {
    const tmp = file + ".tmp-" + randomUUID(), fd = openSync(tmp, "wx", 0o600);
    try {
        try {
            writeFileSync(fd, JSON.stringify(value));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(tmp, file);
        const parent = openSync(dirname(file), "r");
        try {
            fsyncSync(parent);
        }
        finally {
            closeSync(parent);
        }
    }
    finally {
        rmSync(tmp, {
            force: true
        });
    }
}
export class CodexRealmRegistry {
    readonly root: string;
    private readonly authority: string;
    private readonly file: string;
    constructor(root: string) {
        const fresh = !existsSync(root);
        this.root = canonicalPath(root);
        directory(this.root, true);
        this.authority = join(this.root, "authority");
        directory(this.authority, true);
        this.file = join(this.authority, "realms.json");
        this.exclusive(() => {
            if (!existsSync(this.file)) {
                if (!fresh)
                    corrupt("Codex realm authority is missing; cannot create a replacement registry");
                publish(this.file, {
                    version: 1, root: this.root, realms: Object.create(null)
                });
            }
            this.read();
        });
    }
    private exclusive<T>(fn: () => T): T {
        directory(this.root);
        directory(this.authority);
        const result = withHostMutex(this.authority, () => ({
            value: fn()
        }));
        if ("status" in result)
            fail("RT_CODEX_REALM_BUSY", "Codex realm authority is busy; retry the same operation");
        return result.value;
    }
    private read(): Authority {
        let value: Authority;
        try {
            const stat = lstatSync(this.file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
                corrupt("Codex realm authority file is linked or invalid");
            value = JSON.parse(readFileSync(this.file, "utf8"));
        }
        catch (error) {
            if ((error as {
                code?: string;
            }).code === "RT_CODEX_REALM_CORRUPT")
                throw error;
            return corrupt("Codex realm authority is missing or corrupt; preserve it for reconciliation");
        }
        if (!exact(value, ["version", "root", "realms"]) || value.version !== 1 || value.root !== this.root || !value.realms || typeof value.realms !== "object" || Array.isArray(value.realms))
            corrupt("Codex realm authority belongs to another root or is invalid");
        const realmIds = new Set<string>(), attempts = new Set<string>(), nativeIds = new Set<string>();
        for (const [key, row] of Object.entries(value.realms)) {
            if (!row || !exact(row, ["platformSessionId", "realmId", "attemptId", "spec", "specHash", ...(row.nativeSessionId !== undefined ? ["nativeSessionId"] : []), ...(row.stock !== undefined ? ["stock"] : []), ...(row.creation !== undefined ? ["creation"] : [])]) || !identity(row.platformSessionId) || key !== hash(row.platformSessionId) || !uuid.test(row.realmId) || !uuid.test(row.attemptId) || realmIds.has(row.realmId) || attempts.has(row.attemptId) || !exact(row.spec, ["workspace", "reportDir", "inputRoots", "sourceHash"]) || !sha.test(row.spec.sourceHash) || !isAbsolute(row.spec.workspace) || !isAbsolute(row.spec.reportDir) || row.spec.reportDir === row.spec.workspace || !isWithin(row.spec.reportDir, row.spec.workspace) || !Array.isArray(row.spec.inputRoots) || !row.spec.inputRoots.length || row.spec.inputRoots.some(p => !identity(p) || !isAbsolute(p) || isWithin(p, row.spec.reportDir) || isWithin(row.spec.reportDir, p)) || new Set(row.spec.inputRoots).size !== row.spec.inputRoots.length || row.specHash !== hash(row.spec) || row.nativeSessionId !== undefined && (!identity(row.nativeSessionId) || nativeIds.has(row.nativeSessionId)))
                corrupt("Codex realm identity or source facts are corrupt");
            if (row.creation !== undefined && (!exact(row.creation,["phase","claimId"]) || !["preparing","ready","dispatched"].includes(row.creation.phase) || !uuid.test(row.creation.claimId))) corrupt("Codex original creation evidence is invalid");
            if (row.stock !== undefined && !validCodexStock(row.stock)) corrupt("Codex stock authority is invalid");
            realmIds.add(row.realmId);
            attempts.add(row.attemptId);
            if (row.nativeSessionId)
                nativeIds.add(row.nativeSessionId);
        }
        return value;
    }
    private view(row: RecordEntry): CodexRealm {
        const runtimeRoot = join(this.root, "states", row.realmId);
        directory(join(this.root, "states"));
        directory(runtimeRoot);
        return {
            spec: { workspace: row.spec.workspace, evaluation: {reportDir: row.spec.reportDir, inputRoots: [...row.spec.inputRoots]}, sourceHash: row.spec.sourceHash },
            platformSessionId: row.platformSessionId, realmId: row.realmId, attemptId: row.attemptId, expectedHash: hash({
                ...row, nativeSessionId: undefined, stock: undefined, creation: undefined
            }), ...(row.creation ? {creationClaimId: row.creation.claimId} : {}), runtimeRoot, codexHome: join(runtimeRoot, "home", ".codex"), ...(row.nativeSessionId ? {
                nativeSessionId: row.nativeSessionId
            } : {})
        };
    }
    private original(table: Authority, ticket: CodexRealm): RecordEntry {
        const row = table.realms[hash(ticket.platformSessionId)];
        if (!row || this.view(row).expectedHash !== ticket.expectedHash || row.realmId !== ticket.realmId || row.attemptId !== ticket.attemptId || row.creation?.claimId !== ticket.creationClaimId || this.view(row).runtimeRoot !== ticket.runtimeRoot) fail("RT_CODEX_REALM_CONFLICT", "Codex stock creation source differs from original realm");
        return row;
    }
    stock(ticket: CodexRealm): CodexStockManifest | undefined {
        return this.exclusive(() => {const stock = this.original(this.read(), ticket).stock; return stock ? JSON.parse(JSON.stringify(stock)) as CodexStockManifest : undefined;});
    }
    recordStock(ticket: CodexRealm, manifest: CodexStockManifest): void {
        if (!validCodexStock(manifest)) throw new Error("Codex stock manifest invalid");
        this.exclusive(() => {const table = this.read(), row = this.original(table, ticket);
            if (row.stock || row.nativeSessionId) fail("RT_CODEX_REALM_CONFLICT", "Codex stock authority already exists; cannot replace it");
            row.stock = JSON.parse(JSON.stringify(manifest)); publish(this.file, table);
        });
    }
    reserve(platformSessionId: string, spec: CodexRealmSpec): CodexRealm {
        if (!identity(platformSessionId))
            throw new Error("Codex platform session identity is required");
        const source = normalized(spec);
        const overlaps = (a: string, b: string) => isWithin(a, b) || isWithin(b, a);
        if (overlaps(this.root, source.workspace) || source.inputRoots.some(input => overlaps(this.root, input)))
            throw new Error("Codex realm authority/runtime roots overlap job workspace or inputs");
        return this.exclusive(() => {
            const table = this.read(), key = hash(platformSessionId);
            if (Object.hasOwn(table.realms, key))
                fail("RT_CODEX_REALM_PENDING", "Codex realm is already reserved; reconcile pending creation or resume its original native ID");
            const row: RecordEntry = {
                platformSessionId, realmId: randomUUID(), attemptId: randomUUID(), creation: {phase:"preparing",claimId:randomUUID()}, spec: source, specHash: hash(source)
            };
            directory(join(this.root, "states"), true);
            directory(join(this.root, "states", row.realmId), true);
            table.realms[key] = row;
            publish(this.file, table);
            return this.view(row);
        });
    }
    /** Only the host path before thread/start can publish this evidence. Unknown RPC outcomes never call it. */
    markUnexecuted(ticket: CodexRealm): void {
        this.exclusive(() => {const table=this.read(),row=this.original(table,ticket);
            if(row.nativeSessionId || !row.stock || row.creation?.phase!=="preparing") fail("RT_CODEX_REALM_PENDING","Original creation cannot be proved unexecuted");
            row.creation.phase="ready";publish(this.file,table);
        });
    }
    /** Consume the ready receipt once, retaining the original creation intent, state and stock. */
    continueUnexecuted(platformSessionId:string,spec:CodexRealmSpec):CodexRealm {
        if(!identity(platformSessionId))throw new Error("Codex platform session identity is required");
        const source=normalized(spec);
        return this.exclusive(()=>{const table=this.read(),row=table.realms[hash(platformSessionId)];
            if(!row || row.nativeSessionId || !row.stock || row.specHash!==hash(source) || row.creation?.phase!=="ready")fail("RT_CODEX_REALM_PENDING","Original creation lacks matching unexecuted evidence; reconcile it without replacement");
            this.view(row); // Validate the original state before consuming evidence; never recreate it.
            row.creation={phase:"preparing",claimId:randomUUID()};publish(this.file,table);return this.view(row);
        });
    }
    /** Persist uncertainty before invoking native creation, including host death between this write and RPC. */
    markDispatched(ticket:CodexRealm):void {
        this.exclusive(()=>{const table=this.read(),row=this.original(table,ticket);
            if(row.nativeSessionId || !row.stock || row.creation?.phase!=="preparing")fail("RT_CODEX_REALM_PENDING","Original creation claim cannot dispatch");
            row.creation.phase="dispatched";publish(this.file,table);
        });
    }
    bind(ticket: CodexRealm, nativeSessionId: string): CodexRealm {
        if (!identity(nativeSessionId) || !ticket || !identity(ticket.platformSessionId))
            throw new Error("Codex original native identity and creation ticket are required");
        return this.exclusive(() => {
            const table = this.read(), row = table.realms[hash(ticket.platformSessionId)];
            if (!row)
                fail("RT_CODEX_REALM_CONFLICT", "Codex realm creation source is missing");
            const current = this.view(row);
            if (current.realmId !== ticket.realmId || current.attemptId !== ticket.attemptId || current.creationClaimId !== ticket.creationClaimId || current.expectedHash !== ticket.expectedHash || current.runtimeRoot !== ticket.runtimeRoot || row.nativeSessionId && row.nativeSessionId !== nativeSessionId || Object.values(table.realms).some(other => other.realmId !== row.realmId && other.nativeSessionId === nativeSessionId))
                fail("RT_CODEX_REALM_CONFLICT", "Codex realm creation source or original native identity conflicts");
            if (!row.nativeSessionId) {
                row.nativeSessionId = nativeSessionId;
                publish(this.file, table);
            }
            return this.view(row);
        });
    }
    resume(platformSessionId: string, spec: CodexRealmSpec, nativeSessionId: string): CodexRealm {
        if (!identity(platformSessionId) || !identity(nativeSessionId))
            throw new Error("Codex original platform/native identities are required");
        const source = normalized(spec);
        return this.exclusive(() => {
            const row = this.read().realms[hash(platformSessionId)];
            if (!row || row.nativeSessionId !== nativeSessionId || row.specHash !== hash(source))
                fail("RT_CODEX_REALM_CONFLICT", "Codex realm source/native binding differs; cannot replace or rebind it");
            return this.view(row);
        });
    }
    /** Host facts only: state validation happens independently while reading each realm. */
    boundSessions(): Array<{nativeSessionId: string; workspace: string; reportDir: string}> {
        return this.exclusive(() => Object.values(this.read().realms).filter(row => row.nativeSessionId).map(row => ({nativeSessionId: row.nativeSessionId!, workspace: row.spec.workspace, reportDir: row.spec.reportDir})));
    }
    byNative(nativeSessionId: string): CodexRealm | undefined {
        if (!identity(nativeSessionId))
            throw new Error("Codex original native identity is required");
        return this.exclusive(() => {
            const row = Object.values(this.read().realms).find(row => row.nativeSessionId === nativeSessionId);
            return row ? this.view(row) : undefined;
        });
    }
}
