/**
 * The migration lock against a REAL TDengine (deviation 3). The unit suite runs
 * on the fake; only a live server proves the claim the whole design rests on —
 * that `CREATE TABLE` without `IF NOT EXISTS` is an atomic compare-and-swap, so
 * of N racing runners exactly ONE migrates.
 *
 * Gated on `EON_TEST_URL` via `describeIfTdengine`, like the other eon
 * integration suites.
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, expect, it } from "vitest";
import type { EonConnection } from "../src/index.js";
import { EonMigrationRunner } from "../src/index.js";
import {
	connectTestEon,
	describeIfTdengine,
	resetDatabase,
} from "../src/testing/index.js";

const TEST_DB = "eon_migration_lock";
const migrationsDir = fileURLToPath(
	new URL("./fixtures/migrations", import.meta.url),
);

describeIfTdengine("EonMigrationRunner lock (live TDengine)", () => {
	const opened: EonConnection[] = [];

	async function connect(): Promise<EonConnection> {
		const c = await connectTestEon();
		await c.exec(`USE ${TEST_DB}`);
		opened.push(c);
		return c;
	}

	beforeEach(async () => {
		const setup = await connectTestEon();
		await resetDatabase(setup, TEST_DB);
		await setup.close();
	}, 60000);

	afterAll(async () => {
		await Promise.all(opened.map((c) => c.close()));
	});

	it("lets exactly ONE of 8 concurrent runners migrate", async () => {
		// Each runner gets its OWN connection — the deployment shape this guards
		// against is N pods booting at once, not N objects sharing a socket.
		const runners = await Promise.all(
			Array.from({ length: 8 }, async () => {
				const conn = await connect();
				return new EonMigrationRunner(conn, { migrationsDir });
			}),
		);

		const results = await Promise.allSettled(runners.map((r) => r.migrate()));
		const migrated = results.filter(
			(r) => r.status === "fulfilled" && r.value.length > 0,
		);
		const locked = results.filter(
			(r) =>
				r.status === "rejected" &&
				/E_EON_MIGRATION_LOCKED/.test(String(r.reason?.message)),
		);

		expect(migrated).toHaveLength(1);
		expect(migrated.length + locked.length).toBe(8);
	}, 120000);

	it("releases the lock so a later run proceeds", async () => {
		const runner = new EonMigrationRunner(await connect(), { migrationsDir });
		expect(await runner.migrate()).toHaveLength(2);
		// Lock released: a second run gets in and finds nothing pending.
		expect(await runner.migrate()).toEqual([]);
	}, 120000);

	it("reports E_EON_MIGRATION_LOCKED while a lock is held, and clears it", async () => {
		const holder = new EonMigrationRunner(await connect(), { migrationsDir });
		// Take the lock and leave it held, the way a killed process would.
		await holder.migrate();
		const conn = await connect();
		await conn.exec(
			"CREATE TABLE `ream_eon_migrations_lock` (`locked_at` TIMESTAMP, `token` VARCHAR(64))",
		);

		const blocked = new EonMigrationRunner(await connect(), { migrationsDir });
		await expect(blocked.migrate()).rejects.toThrow(/E_EON_MIGRATION_LOCKED/);

		expect(await blocked.forceUnlock()).toBe(true);
		// Nothing held any more.
		expect(await blocked.forceUnlock()).toBe(false);
		await expect(blocked.migrate()).resolves.toEqual([]);
	}, 120000);
});
