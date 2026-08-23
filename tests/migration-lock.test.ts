/**
 * The eon migration lock (deviation 3): the lock is the lock TABLE's existence,
 * taken with a `CREATE TABLE` that omits `IF NOT EXISTS`. These run on the fake,
 * which rejects a duplicate CREATE with code 1539 exactly as a live server does;
 * `migration-lock.integration.test.ts` proves the same behaviour for real.
 */
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { EonMigrationRunner } from "../src/index.js";
import { FakeEonConnection } from "../src/testing/index.js";

const migrationsDir = fileURLToPath(
	new URL("./fixtures/migrations", import.meta.url),
);

describe("EonMigrationRunner > migration lock", () => {
	let conn: FakeEonConnection;
	let runner: EonMigrationRunner;

	beforeEach(() => {
		conn = new FakeEonConnection();
		runner = new EonMigrationRunner(conn, { migrationsDir });
	});

	it("takes the lock by creating the lock table WITHOUT ifNotExists", async () => {
		await runner.migrate();
		// Not `IF NOT EXISTS` — that is the whole point: the create must be able
		// to fail, or it cannot serialise anything.
		expect(conn.statements).toContain(
			"CREATE TABLE `ream_eon_migrations_lock` (`locked_at` TIMESTAMP, `token` VARCHAR(64))",
		);
	});

	it("releases the lock when the run finishes", async () => {
		await runner.migrate();
		expect(conn.statements).toContain(
			"DROP TABLE IF EXISTS `ream_eon_migrations_lock`",
		);
		// Released means a second run can take it again.
		await expect(runner.migrate()).resolves.toEqual([]);
	});

	it("refuses to migrate while another runner holds the lock", async () => {
		const other = new EonMigrationRunner(conn, { migrationsDir });
		// Hold the lock by starting a run that never releases: emulate it by
		// creating the table on the same connection first.
		await conn.exec(
			"CREATE TABLE `ream_eon_migrations_lock` (`locked_at` TIMESTAMP, `token` VARCHAR(64))",
		);
		await expect(other.migrate()).rejects.toThrow(/E_EON_MIGRATION_LOCKED/);
	});

	it("releases the lock even when a migration throws", async () => {
		const failing = fileURLToPath(
			new URL("./fixtures/failing-migrations", import.meta.url),
		);
		const r = new EonMigrationRunner(conn, { migrationsDir: failing });
		await expect(r.migrate()).rejects.toThrow();
		// A crash must not wedge every later run — the lock is gone.
		expect(conn.statements).toContain(
			"DROP TABLE IF EXISTS `ream_eon_migrations_lock`",
		);
	});

	it("never takes the lock when disableLocks is set", async () => {
		const r = new EonMigrationRunner(conn, {
			migrationsDir,
			disableLocks: true,
		});
		await r.migrate();
		expect(
			conn.statements.some((s) => s.includes("ream_eon_migrations_lock")),
		).toBe(false);
	});

	it("reset does not deadlock against its own lock", async () => {
		await runner.migrate();
		// `reset` loops over rollbacks; if it re-entered the public `rollback()` it
		// would try to re-take a lock it already holds and fail with 1539.
		await expect(runner.reset()).resolves.toEqual([
			"0002_add_voltage",
			"0001_create_meters",
		]);
	});

	it("refresh holds ONE lock across the whole reset+migrate", async () => {
		await runner.migrate();
		conn.statements.length = 0;
		await runner.refresh();
		const takes = conn.statements.filter(
			(s) =>
				s ===
				"CREATE TABLE `ream_eon_migrations_lock` (`locked_at` TIMESTAMP, `token` VARCHAR(64))",
		);
		expect(takes).toHaveLength(1);
	});

	it("forceUnlock clears a lock left behind by a killed process", async () => {
		await conn.exec(
			"CREATE TABLE `ream_eon_migrations_lock` (`locked_at` TIMESTAMP, `token` VARCHAR(64))",
		);
		expect(await runner.forceUnlock()).toBe(true);
		// Cleared, so a normal run works again.
		await expect(runner.migrate()).resolves.toHaveLength(2);
	});

	it("forceUnlock reports false when no lock is held", async () => {
		expect(await runner.forceUnlock()).toBe(false);
	});
});
