import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { EonMigrationRunner } from "../src/index.js";
import { FakeEonConnection } from "../src/testing/index.js";

const migrationsDir = fileURLToPath(
	new URL("./fixtures/migrations", import.meta.url),
);

describe("EonMigrationRunner", () => {
	let conn: FakeEonConnection;
	let runner: EonMigrationRunner;

	beforeEach(() => {
		conn = new FakeEonConnection();
		runner = new EonMigrationRunner(conn, { migrationsDir });
	});

	it("rejects an unsafe tracking-table name at construction", () => {
		expect(
			() => new EonMigrationRunner(conn, { tableName: "bad name" }),
		).toThrow(/E_EON_MIGRATION_INVALID/);
	});

	it("init creates the ream_ tracking table via the basic-table path", async () => {
		await runner.init();
		expect(conn.statements).toContain(
			"CREATE TABLE IF NOT EXISTS `ream_eon_migrations` (`executed_at` TIMESTAMP, `name` VARCHAR(255), `batch` INT)",
		);
	});

	it("migrate runs pending migrations in filename order and tracks them", async () => {
		const executed = await runner.migrate();
		expect(executed).toEqual(["0001_create_meters", "0002_add_voltage"]);
		// The real compiled DDL reached the connection.
		expect(conn.statements).toContain(
			"CREATE STABLE IF NOT EXISTS `meters` (`ts` TIMESTAMP, `current` FLOAT) TAGS (`groupid` INT)",
		);
		expect(conn.statements).toContain(
			"ALTER STABLE `meters` ADD COLUMN `voltage` INT",
		);
		// Two tracking records, both batch 1.
		expect(conn.rows("ream_eon_migrations").map((r) => r.name)).toEqual([
			"0001_create_meters",
			"0002_add_voltage",
		]);
		expect(conn.rows("ream_eon_migrations").every((r) => r.batch === 1)).toBe(
			true,
		);
	});

	it("status reports applied vs pending", async () => {
		const before = await runner.status();
		expect(before).toEqual([
			{ name: "0001_create_meters", status: "pending" },
			{ name: "0002_add_voltage", status: "pending" },
		]);
		await runner.migrate();
		const after = await runner.status();
		expect(after).toEqual([
			{ name: "0001_create_meters", status: "applied", batch: 1 },
			{ name: "0002_add_voltage", status: "applied", batch: 1 },
		]);
	});

	it("migrate is idempotent — a second call runs nothing", async () => {
		await runner.migrate();
		expect(await runner.migrate()).toEqual([]);
	});

	it("rollback reverses the last batch (reverse filename order) and untracks", async () => {
		await runner.migrate();
		const rolled = await runner.rollback();
		expect(rolled).toEqual(["0002_add_voltage", "0001_create_meters"]);
		expect(conn.statements).toContain(
			"ALTER STABLE `meters` DROP COLUMN `voltage`",
		);
		expect(conn.statements).toContain("DROP STABLE IF EXISTS `meters`");
		expect(conn.rows("ream_eon_migrations")).toEqual([]);
		expect((await runner.status()).every((s) => s.status === "pending")).toBe(
			true,
		);
	});

	it("reset rolls back everything; refresh re-applies", async () => {
		await runner.migrate();
		const { rolled, executed } = await runner.refresh();
		expect(rolled).toEqual(["0002_add_voltage", "0001_create_meters"]);
		expect(executed).toEqual(["0001_create_meters", "0002_add_voltage"]);
	});

	it("dryRun returns the SQL without executing or tracking", async () => {
		const plan = await runner.dryRun();
		expect(plan).toEqual([
			{
				name: "0001_create_meters",
				sql: [
					"CREATE STABLE IF NOT EXISTS `meters` (`ts` TIMESTAMP, `current` FLOAT) TAGS (`groupid` INT)",
				],
			},
			{
				name: "0002_add_voltage",
				sql: ["ALTER STABLE `meters` ADD COLUMN `voltage` INT"],
			},
		]);
		// No DDL executed, no records written (only the init CREATE TABLE ran).
		expect(conn.statements).not.toContain(
			"CREATE STABLE IF NOT EXISTS `meters` (`ts` TIMESTAMP, `current` FLOAT) TAGS (`groupid` INT)",
		);
		expect(conn.rows("ream_eon_migrations")).toEqual([]);
	});

	it("an empty migrations dir yields nothing (no throw)", async () => {
		const empty = new EonMigrationRunner(conn, {
			migrationsDir: `${migrationsDir}-does-not-exist`,
		});
		expect(await empty.status()).toEqual([]);
		expect(await empty.migrate()).toEqual([]);
	});
});
