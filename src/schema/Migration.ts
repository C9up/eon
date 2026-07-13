/**
 * `Migration` — extend this to author a versioned eon (TDengine) migration.
 *
 * Mirrors atlas `Migration` (`schema/Migration.ts`): `up()`/`down()` drive a
 * fluent `EonSchema`, and `getUpSQL()`/`getDownSQL()` replay the callback to
 * collect the compiled SQL. Single-dialect (TDengine) so — unlike atlas — the
 * constructor takes NO dialect argument, and there is no `now()`/`defaultTo`
 * helper (TDengine columns have no `DEFAULT`).
 *
 * TDengine caveat (AC6): DDL is non-transactional and some operations are
 * irreversible (a `MODIFY` length-extension cannot be un-extended, a dropped
 * column's data is gone) — `down()` is best-effort. Prefer idempotent DDL
 * (`IF (NOT) EXISTS`, the `EonSchema` default) so a partially-applied migration
 * re-runs cleanly.
 *
 *     import { Migration } from "@c9up/eon";
 *
 *     export default class CreateMeters extends Migration {
 *       up() {
 *         this.schema.createDatabase("metrics", { keep: "90d", duration: "10d" });
 *         this.schema.createStable("meters", (t) => {
 *           t.timestamp("ts");
 *           t.float("current");
 *           t.int("groupid").tag();
 *         });
 *       }
 *       down() {
 *         this.schema.dropStable("meters");
 *       }
 *     }
 */

import { EonSchema } from "./EonSchema.js";

export abstract class Migration {
	readonly schema: EonSchema;

	constructor() {
		this.schema = new EonSchema();
	}

	/** Apply the migration. */
	abstract up(): Promise<void> | void;

	/** Reverse the migration (best-effort on TDengine — see class docs). */
	abstract down(): Promise<void> | void;

	/** Queue a raw SQL statement verbatim (escape hatch for un-modelled DDL). */
	raw(sql: string): void {
		this.schema.raw(sql);
	}

	/** Compile the SQL statements this migration's `up()` produces. */
	async getUpSQL(): Promise<string[]> {
		this.schema.reset();
		await this.up();
		return this.schema.toSQL();
	}

	/** Compile the SQL statements this migration's `down()` produces. */
	async getDownSQL(): Promise<string[]> {
		this.schema.reset();
		await this.down();
		return this.schema.toSQL();
	}
}
