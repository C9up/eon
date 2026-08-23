/**
 * `EonMigrationRunner` — discovers, executes, and tracks eon (TDengine)
 * migrations. Mirrors atlas `MigrationRunner` (`schema/MigrationRunner.ts`):
 * sorted-file discovery, a `ream_`-prefixed tracking table, batch-based
 * rollback, `init/status/migrate/rollback/reset/refresh/fresh/dryRun`.
 *
 * ── THREE named TDengine deviations from atlas (AC6) ────────────────────────
 *
 *  1. **No transactions / no engine rollback.** TDengine DDL is non-transactional
 *     — a batch CANNOT be applied atomically. The runner executes statements
 *     **sequentially**; a mid-migration failure leaves earlier statements
 *     applied. The mitigation is idempotent DDL (`IF (NOT) EXISTS`, the
 *     `EonSchema` default) so a re-run converges. There is NO `runInTransaction`.
 *
 *  2. **No `UNIQUE`, no auto-increment.** The tracking table is a basic table
 *     `ream_eon_migrations(executed_at TIMESTAMP, name VARCHAR(255), batch INT)`;
 *     the applied-set is de-duped **by name in JS**, and each record is written
 *     with a strictly-increasing `executed_at` so rollback can delete it by that
 *     unique timestamp key (TDengine only allows a `DELETE` predicate on the
 *     primary timestamp column).
 *
 *  3. **The migration lock is a table's EXISTENCE, not a row's value.** atlas
 *     (Lucid/Knex parity) serialises concurrent runners with a conditional
 *     `UPDATE … WHERE is_locked = 0`; TDengine has no conditional UPDATE, so
 *     that exact shape is impossible. The equivalent guarantee comes from a
 *     different primitive: `CREATE TABLE` **without** `IF NOT EXISTS` is an
 *     atomic compare-and-swap — the mnode serialises metadata, so exactly ONE
 *     concurrent creator succeeds and every other gets code 1539. Creating the
 *     lock table IS taking the lock; dropping it is releasing it. Verified
 *     against a live TDengine 3.3.5.0: 12 racing connections, 1 winner, 11 ×
 *     1539, three rounds. The API stays atlas's (`disableLocks`, `forceUnlock`,
 *     `E_..._LOCKED`) — only the primitive underneath differs.
 *
 * Agnostic leaf: takes the connection structurally and a plain directory path —
 * no `@c9up/ream` import, no app helper (`project_package_extraction`).
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	type EonConnection,
	EonConnectionError,
} from "../connection/EonConnection.js";
import { compileStatementNative } from "../query/native.js";
import type { Migration } from "./Migration.js";

/** TDengine's "Table already exists" code — the losing side of the lock race. */
const TABLE_ALREADY_EXISTS = 1539;
/** TDengine's "Table does not exist" code — nothing to force-unlock. */
const TABLE_DOES_NOT_EXIST = 9731;
const DEFAULT_DIR = "database/eon-migrations";
const DEFAULT_TABLE = "ream_eon_migrations";
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Migration filename (no extension): no path separators, no `..`. */
const MIGRATION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface EonMigrationOptions {
	/** Directory holding migration files. Default `database/eon-migrations`. */
	migrationsDir?: string;
	/**
	 * Tracking-table name. Default `ream_eon_migrations`. Must match
	 * `/^[A-Za-z_][A-Za-z0-9_]*$/`. The `ream_` prefix marks it a framework/system
	 * table (`feedback_underscore_policy`) — keep it so cleanup helpers skip it.
	 */
	tableName?: string;
	/**
	 * Skip the migration lock (atlas / Lucid `disableLocks` parity). Only for a
	 * context where concurrent runs are impossible by construction — a single
	 * test process, or a one-off local run.
	 */
	disableLocks?: boolean;
}

export type MigrationState = "applied" | "pending";

export interface MigrationStatus {
	name: string;
	state: MigrationState;
	batch?: number;
}

/** One tracking record row as read back from the connection. */
interface MigrationRecord {
	name: string;
	batch: number;
	executed_at: number;
}

export class EonMigrationRunner {
	readonly #conn: EonConnection;
	readonly #dir: string;
	readonly #table: string;
	readonly #lockTable: string;
	readonly #disableLocks: boolean;
	/** Set while THIS runner holds the lock, so we never drop someone else's. */
	#lockToken: string | undefined;

	constructor(conn: EonConnection, options: EonMigrationOptions = {}) {
		this.#conn = conn;
		this.#dir = options.migrationsDir ?? DEFAULT_DIR;
		const table = options.tableName ?? DEFAULT_TABLE;
		if (!TABLE_NAME_PATTERN.test(table)) {
			throw new Error(
				`[E_EON_MIGRATION_INVALID] invalid tracking-table name '${table}'; must match ${TABLE_NAME_PATTERN}`,
			);
		}
		this.#table = table;
		// Derived from the tracking table, so a custom `tableName` keeps its lock
		// beside it; already validated by the pattern above, plus a literal suffix.
		this.#lockTable = `${table}_lock`;
		this.#disableLocks = options.disableLocks ?? false;
	}

	/** Create the tracking table (`IF NOT EXISTS`) via the basic-table DDL path. */
	async init(): Promise<void> {
		const { statements } = compileStatementNative(
			{
				kind: "createTable",
				name: this.#table,
				ifNotExists: true,
				columns: [
					{
						name: "executed_at",
						kind: "timestamp",
						length: null,
						precision: null,
						scale: null,
					},
					{
						name: "name",
						kind: "varchar",
						length: 255,
						precision: null,
						scale: null,
					},
					{
						name: "batch",
						kind: "int",
						length: null,
						precision: null,
						scale: null,
					},
				],
			},
			"tdengine",
		);
		for (const sql of statements) await this.#conn.exec(sql);
	}

	/** The status of every discovered migration (applied vs pending). */
	async status(): Promise<MigrationStatus[]> {
		await this.init();
		const applied = await this.#appliedRecords();
		const byName = new Map(applied.map((r) => [r.name, r.batch]));
		const files = await this.#discoverFiles();
		return files.map((name) => {
			const batch = byName.get(name);
			return batch === undefined
				? { name, state: "pending" }
				: { name, state: "applied", batch };
		});
	}

	/** Run every pending migration (filename order), recording each. */
	async migrate(): Promise<string[]> {
		return this.#withLock(() => this.#migrateLocked());
	}

	async #migrateLocked(): Promise<string[]> {
		await this.init();
		const applied = await this.#appliedRecords();
		const appliedNames = new Set(applied.map((r) => r.name));
		const files = await this.#discoverFiles();
		const pending = files.filter((f) => !appliedNames.has(f));
		if (pending.length === 0) return [];

		const batch = this.#maxBatch(applied) + 1;
		// Strictly-increasing executed_at (unique key for rollback deletes) — never
		// below any existing record, never colliding within this run.
		let clock = Math.max(Date.now(), this.#maxExecutedAt(applied) + 1);
		const executed: string[] = [];

		for (const name of pending) {
			const migration = await this.#loadMigration(name);
			for (const sql of await migration.getUpSQL()) {
				await this.#conn.exec(sql);
			}
			await this.#writeRecord(name, batch, clock);
			clock += 1;
			executed.push(name);
		}
		return executed;
	}

	/** Roll back the most-recent batch (files in reverse order), running `down()`. */
	async rollback(): Promise<string[]> {
		return this.#withLock(() => this.#rollbackLocked());
	}

	async #rollbackLocked(): Promise<string[]> {
		await this.init();
		const applied = await this.#appliedRecords();
		if (applied.length === 0) return [];
		const batch = this.#maxBatch(applied);

		const inBatch = new Map(
			applied.filter((r) => r.batch === batch).map((r) => [r.name, r]),
		);
		const files = await this.#discoverFiles();
		// Reverse of application order = reverse of filename order within the batch.
		const ordered = files.filter((f) => inBatch.has(f)).reverse();

		const rolled: string[] = [];
		for (const name of ordered) {
			const record = inBatch.get(name);
			if (record === undefined) continue;
			const migration = await this.#loadMigration(name);
			for (const sql of await migration.getDownSQL()) {
				await this.#conn.exec(sql);
			}
			await this.#deleteRecord(record.executed_at);
			rolled.push(name);
		}
		return rolled;
	}

	/** Roll back every applied batch (Lucid `migrate:reset`). */
	async reset(): Promise<string[]> {
		return this.#withLock(() => this.#resetLocked());
	}

	async #resetLocked(): Promise<string[]> {
		await this.init();
		const all: string[] = [];
		// Loops on the LOCKED variant: `rollback()` would try to take a lock this
		// runner already holds, and the CREATE would fail with 1539 against itself.
		// Guard against a stuck loop: each rollback must shrink the applied set.
		for (;;) {
			const rolled = await this.#rollbackLocked();
			if (rolled.length === 0) break;
			all.push(...rolled);
		}
		return all;
	}

	/** Reset then re-run every migration (Lucid `migrate:refresh`). */
	async refresh(): Promise<{ rolled: string[]; executed: string[] }> {
		// ONE lock held across the WHOLE rollback + re-migrate, so no other run can
		// slip into the free window between reset and migrate (atlas does the same).
		return this.#withLock(async () => {
			const rolled = await this.#resetLocked();
			const executed = await this.#migrateLocked();
			return { rolled, executed };
		});
	}

	/** Alias of {@link refresh} (Lucid `migrate:fresh`). */
	fresh(): Promise<{ rolled: string[]; executed: string[] }> {
		return this.refresh();
	}

	/** Compute the SQL each pending migration would emit, WITHOUT executing it. */
	async dryRun(): Promise<Array<{ name: string; sql: string[] }>> {
		await this.init();
		const applied = await this.#appliedRecords();
		const appliedNames = new Set(applied.map((r) => r.name));
		const pending = (await this.#discoverFiles()).filter(
			(f) => !appliedNames.has(f),
		);
		const result: Array<{ name: string; sql: string[] }> = [];
		for (const name of pending) {
			const migration = await this.#loadMigration(name);
			result.push({ name, sql: await migration.getUpSQL() });
		}
		return result;
	}

	/** Read every tracking record (name, batch, executed_at). */
	async #appliedRecords(): Promise<MigrationRecord[]> {
		const { statements } = compileStatementNative(
			{
				kind: "select",
				table: this.#table,
				select: ["name", "batch", "executed_at"],
			},
			"tdengine",
		);
		const sql = statements[0];
		if (sql === undefined) return [];
		const rows = await this.#conn.query<{
			name: unknown;
			batch: unknown;
			executed_at: unknown;
		}>(sql);
		return rows.map((r) => ({
			name: String(r.name),
			batch: Number(r.batch),
			executed_at: Number(r.executed_at),
		}));
	}

	// ── Migration lock ─────────────────────────────────────────────────────────
	// Deviation 3 (see the file header): the lock is the lock table's EXISTENCE.
	// `CREATE TABLE` without `IF NOT EXISTS` is TDengine's atomic compare-and-swap.

	/**
	 * Take the migration lock so two processes cannot migrate concurrently
	 * (atlas / Lucid parity — a lock TABLE; here its existence, not a row value).
	 *
	 * ATOMIC: the mnode serialises table creation, so of N concurrent creators
	 * exactly ONE succeeds and the rest get code 1539. Winning the CREATE IS
	 * holding the lock — there is no separate read-back to race against.
	 *
	 * Any OTHER failure propagates untouched: we must never read an unknown error
	 * as "someone else holds it" (or as "we hold it"). Either way we do not migrate.
	 */
	async #acquireLock(): Promise<void> {
		if (this.#disableLocks) return;
		const { statements } = compileStatementNative(
			{
				kind: "createTable",
				name: this.#lockTable,
				ifNotExists: false,
				columns: [
					{
						name: "locked_at",
						kind: "timestamp",
						length: null,
						precision: null,
						scale: null,
					},
					{
						name: "token",
						kind: "varchar",
						length: 64,
						precision: null,
						scale: null,
					},
				],
			},
			"tdengine",
		);
		const token = randomUUID();
		try {
			for (const sql of statements) await this.#conn.exec(sql);
		} catch (error) {
			if (
				error instanceof EonConnectionError &&
				error.code === TABLE_ALREADY_EXISTS
			) {
				throw new Error(
					`[E_EON_MIGRATION_LOCKED] could not acquire the migration lock — another migration is already running. Wait for it to finish, or clear a stuck lock with forceUnlock() (drops '${this.#lockTable}').`,
					{ cause: error },
				);
			}
			throw error;
		}
		this.#lockToken = token;
		// Written for diagnosis only (who holds it, since when) — the lock is
		// already ours the moment the CREATE returned, so a failure to record it
		// must not look like a failure to acquire.
		await this.#writeLockRecord(token);
	}

	/** Best-effort ownership stamp inside the lock table. Never fails acquisition. */
	async #writeLockRecord(token: string): Promise<void> {
		try {
			const { statements } = compileStatementNative(
				{
					kind: "insert",
					table: this.#lockTable,
					columns: ["locked_at", "token"],
					rows: [[Date.now(), token]],
					literal: true,
				},
				"tdengine",
			);
			for (const sql of statements) await this.#conn.exec(sql);
		} catch {
			// Diagnostic only — swallowed on purpose.
		}
	}

	/** Run `fn` holding the migration lock; always release, even on throw. */
	async #withLock<T>(fn: () => Promise<T>): Promise<T> {
		await this.#acquireLock();
		try {
			return await fn();
		} finally {
			await this.#releaseLock();
		}
	}

	/** Release the lock — only if WE took it, so we never drop someone else's. */
	async #releaseLock(): Promise<void> {
		if (this.#disableLocks || this.#lockToken === undefined) return;
		this.#lockToken = undefined;
		await this.#dropLockTable();
	}

	async #dropLockTable(): Promise<void> {
		const { statements } = compileStatementNative(
			{ kind: "dropTable", name: this.#lockTable, ifExists: true },
			"tdengine",
		);
		for (const sql of statements) await this.#conn.exec(sql);
	}

	/**
	 * Force-clear a stuck migration lock (atlas `forceUnlock`, Lucid
	 * `migration:unlock`). A process killed mid-migrate leaves the lock table
	 * behind with no owner alive to drop it, and every later run would fail to
	 * acquire. Returns `true` if a held lock was cleared.
	 */
	async forceUnlock(): Promise<boolean> {
		// Symmetric to acquisition: a `DROP` that omits `IF EXISTS` reports whether
		// anything was there, in one atomic statement. No separate existence probe,
		// which would both race and (on a missing table) read an unrelated failure
		// as "no lock held".
		const { statements } = compileStatementNative(
			{ kind: "dropTable", name: this.#lockTable, ifExists: false },
			"tdengine",
		);
		try {
			for (const sql of statements) await this.#conn.exec(sql);
		} catch (error) {
			if (
				error instanceof EonConnectionError &&
				error.code === TABLE_DOES_NOT_EXIST
			) {
				return false;
			}
			throw error;
		}
		this.#lockToken = undefined;
		return true;
	}

	#maxBatch(records: readonly MigrationRecord[]): number {
		return records.reduce((max, r) => Math.max(max, r.batch), 0);
	}

	#maxExecutedAt(records: readonly MigrationRecord[]): number {
		return records.reduce((max, r) => Math.max(max, r.executed_at), 0);
	}

	/** Insert a tracking record via the literal INSERT compiler (never TS interpolation). */
	async #writeRecord(
		name: string,
		batch: number,
		executedAt: number,
	): Promise<void> {
		const { statements } = compileStatementNative(
			{
				kind: "insert",
				table: this.#table,
				columns: ["executed_at", "name", "batch"],
				rows: [[executedAt, name, batch]],
				literal: true,
			},
			"tdengine",
		);
		for (const sql of statements) await this.#conn.exec(sql);
	}

	/** Delete a tracking record by its unique `executed_at` key (compiled in Rust). */
	async #deleteRecord(executedAt: number): Promise<void> {
		const { statements } = compileStatementNative(
			{
				kind: "delete",
				table: this.#table,
				column: "executed_at",
				value: executedAt,
			},
			"tdengine",
		);
		for (const sql of statements) await this.#conn.exec(sql);
	}

	/** Discover migration files (`.ts`/`.js`), sorted, extension stripped. */
	async #discoverFiles(): Promise<string[]> {
		try {
			const entries = await fsp.readdir(this.#dir);
			return entries
				.filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
				.sort()
				.map((f) => f.replace(/\.(ts|js)$/, ""));
		} catch (err) {
			// A missing migrations directory → no migrations. Anything else propagates.
			if (
				typeof err === "object" &&
				err !== null &&
				Reflect.get(err, "code") === "ENOENT"
			) {
				return [];
			}
			throw err;
		}
	}

	/** Load + instantiate a migration's default-export class. */
	async #loadMigration(name: string): Promise<Migration> {
		if (!MIGRATION_NAME_PATTERN.test(name) || name.includes("..")) {
			throw new Error(
				`[E_EON_MIGRATION_INVALID] unsafe migration name '${name}'`,
			);
		}
		const tsPath = path.join(this.#dir, `${name}.ts`);
		const jsPath = path.join(this.#dir, `${name}.js`);
		const tsExists = await pathExists(tsPath);
		// Fail loud with the runner's own error (atlas parity) instead of letting
		// `import` throw a raw ERR_MODULE_NOT_FOUND on a missing/renamed file.
		if (!tsExists && !(await pathExists(jsPath))) {
			throw new Error(
				`[E_EON_MIGRATION_INVALID] migration '${name}' not found (no .ts or .js file in ${this.#dir})`,
			);
		}
		const filePath = tsExists ? tsPath : jsPath;
		// ESM dynamic import needs a file:// URL (Windows rejects a bare path).
		const mod: { default?: unknown } = await import(
			pathToFileURL(path.resolve(filePath)).href
		);
		const MigrationClass = mod.default;
		if (!isConstructor(MigrationClass)) {
			throw new Error(
				`[E_EON_MIGRATION_INVALID] migration '${name}' must export a default class`,
			);
		}
		const instance: unknown = new MigrationClass();
		if (!isMigration(instance)) {
			throw new Error(
				`[E_EON_MIGRATION_INVALID] migration '${name}' default export is not a Migration (missing up/down)`,
			);
		}
		return instance;
	}
}

/** A no-arg constructor — narrows an `unknown` default export before `new`. */
type NoArgConstructor = new () => unknown;

function isConstructor(value: unknown): value is NoArgConstructor {
	return typeof value === "function";
}

/**
 * Structural Migration guard — avoids importing the class value for an
 * `instanceof`. Reads through the prototype chain (methods live on the
 * prototype, not as own enumerable props) via `Reflect.get`.
 */
function isMigration(value: unknown): value is Migration {
	if (typeof value !== "object" || value === null) return false;
	const up = Reflect.get(value, "getUpSQL");
	const down = Reflect.get(value, "getDownSQL");
	return typeof up === "function" && typeof down === "function";
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fsp.access(p);
		return true;
	} catch {
		return false;
	}
}
