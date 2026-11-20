/**
 * Move the child tables eon named with its former 64-bit FNV-1a scheme (up to
 * 0.2.15) onto the collision-resistant names {@link childTableName} gives now.
 *
 * A child table cannot be renamed in TDengine, so each one is copied: the new
 * child is created with the old one's tag values, its rows are copied with
 * `INSERT … SELECT`, then the old child is dropped. Re-running after an
 * interruption is safe: a row copied twice lands on the same timestamp, which
 * TDengine overwrites instead of duplicating, and a child already on its new
 * name is left alone.
 *
 * Only children whose current name IS the legacy name of their own tags are
 * moved. A child created with an explicit `name`, or whose tags read back in
 * another JavaScript type than the one it was ingested with (a `number` for a
 * BIGINT tag ingested as `bigint`), is reported in `unmatched` and left alone:
 * moving it to a name the application never computes would split its series.
 */

import type { EonConnection } from "../connection/EonConnection.js";
import { quoteIdentNative } from "../query/native.js";
import { compileCreateStableSpec, type SuperTableClass } from "./compile.js";
import {
	childTableName,
	createChildTable,
	legacyChildTableName,
} from "./sync.js";

/** One child moved (or, under `dryRun`, to be moved) to its new name. */
export interface ChildTableRename {
	readonly from: string;
	readonly to: string;
	readonly tags: readonly unknown[];
}

/** What {@link migrateChildTableNames} did, child by child. */
export interface ChildTableMigrationReport {
	/** Children moved from their legacy name to the current one. */
	readonly renamed: readonly ChildTableRename[];
	/** Children already on the current name. */
	readonly current: readonly string[];
	/** Children under neither name (explicit names, retyped tags): left alone. */
	readonly unmatched: readonly string[];
}

export interface MigrateChildTableNamesOptions {
	/** Report what would move without writing anything. Default `false`. */
	readonly dryRun?: boolean;
}

/** Alias of the child-name column in the tag listing (not a declared column). */
const CHILD_ALIAS = "eon_child_name";

export async function migrateChildTableNames(
	conn: EonConnection,
	EntityClass: SuperTableClass,
	options: MigrateChildTableNamesOptions = {},
): Promise<ChildTableMigrationReport> {
	const spec = compileCreateStableSpec(EntityClass);
	const stable = spec.name;
	const tagNames = spec.tags.map((t) => t.name);
	const columns = spec.columns.map((c) => quoteIdentNative(c.name)).join(", ");

	const children = await conn.query(
		`SELECT DISTINCT TBNAME AS ${CHILD_ALIAS}, ${tagNames.map(quoteIdentNative).join(", ")} FROM ${quoteIdentNative(stable)}`,
	);

	const renamed: ChildTableRename[] = [];
	const current: string[] = [];
	const unmatched: string[] = [];
	for (const row of children) {
		const from = row[CHILD_ALIAS];
		if (typeof from !== "string") {
			throw new Error(
				`[E_EON_CHILD_MIGRATION] the child listing of '${stable}' returned no table name`,
			);
		}
		const tags = tagNames.map((name) => row[name] ?? null);
		const to = childTableName(stable, tags);
		if (from === to) {
			current.push(from);
		} else if (from === legacyChildTableName(stable, tags)) {
			renamed.push({ from, to, tags });
		} else {
			unmatched.push(from);
		}
	}

	if (options.dryRun !== true) {
		for (const { from, to, tags } of renamed) {
			await createChildTable(conn, {
				stable,
				name: to,
				tags: [...tags],
				ifNotExists: true,
			});
			await conn.exec(
				`INSERT INTO ${quoteIdentNative(to)} (${columns}) SELECT ${columns} FROM ${quoteIdentNative(from)}`,
			);
			await conn.exec(`DROP TABLE IF EXISTS ${quoteIdentNative(from)}`);
		}
	}

	return { renamed, current, unmatched };
}
