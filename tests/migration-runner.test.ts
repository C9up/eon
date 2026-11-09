import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

	it.each([
		["ms", 1n],
		["us", 1_000n],
		["ns", 1_000_000n],
	] as const)(
		"records executed_at in a '%s' database's own unit, and rolls it back",
		async (precision, perMs) => {
			const fake = new FakeEonConnection({ precision });
			const scoped = new EonMigrationRunner(fake, { migrationsDir });
			const floor = BigInt(Date.now()) * perMs;
			await scoped.migrate();
			const stamps = fake
				.rows("ream_eon_migrations")
				.map((r) => BigInt(String(r.executed_at)));
			expect(stamps).toHaveLength(2);
			for (const stamp of stamps) {
				expect(stamp >= floor).toBe(true);
				// Not a later unit either: within a minute of the floor.
				expect(stamp - floor < 60_000n * perMs).toBe(true);
			}
			const [first, second] = stamps;
			if (first === undefined || second === undefined) throw new Error("rows");
			expect(second > first).toBe(true);
			await scoped.rollback();
			expect(fake.rows("ream_eon_migrations")).toEqual([]);
		},
	);
});

describe("EonMigrationRunner — file discovery", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function dirWith(files: Record<string, string>): string {
		const dir = mkdtempSync(path.join(tmpdir(), "eon-migrations-"));
		dirs.push(dir);
		for (const [name, body] of Object.entries(files)) {
			writeFileSync(path.join(dir, name), body);
		}
		return dir;
	}

	const esm = (table: string): string =>
		`export default class { getUpSQL() { return ["CREATE TABLE ${table} (ts TIMESTAMP, v INT)"]; } getDownSQL() { return ["DROP TABLE ${table}"]; } }\n`;

	it("ignores declaration files next to the migration", async () => {
		const migrationsDir = dirWith({
			"001_create.mjs": esm("a"),
			"001_create.d.ts": "export {};\n",
			"001_create.d.mts": "export {};\n",
		});
		const runner = new EonMigrationRunner(new FakeEonConnection(), {
			migrationsDir,
		});
		expect(await runner.status()).toEqual([
			{ name: "001_create", status: "pending" },
		]);
		expect(await runner.migrate()).toEqual(["001_create"]);
	});

	it("discovers .mjs and .cjs migrations", async () => {
		const migrationsDir = dirWith({
			"001_esm.mjs": esm("a"),
			"002_cjs.cjs": `module.exports = class { getUpSQL() { return ["CREATE TABLE b (ts TIMESTAMP, v INT)"]; } getDownSQL() { return []; } };\n`,
			"notes.txt": "not a migration\n",
		});
		const conn = new FakeEonConnection();
		const runner = new EonMigrationRunner(conn, { migrationsDir });
		expect(await runner.migrate()).toEqual(["001_esm", "002_cjs"]);
		expect(conn.statements).toContain("CREATE TABLE b (ts TIMESTAMP, v INT)");
	});

	it("refuses two files that resolve to the same migration name", async () => {
		const migrationsDir = dirWith({
			"001_create.ts": esm("a"),
			"001_create.js": esm("a"),
		});
		const conn = new FakeEonConnection();
		const runner = new EonMigrationRunner(conn, { migrationsDir });
		await expect(runner.status()).rejects.toThrow(
			/E_EON_MIGRATION_INVALID.*001_create.*001_create\.js.*001_create\.ts/,
		);
		await expect(runner.migrate()).rejects.toThrow(/E_EON_MIGRATION_INVALID/);
		await expect(runner.dryRun()).rejects.toThrow(/E_EON_MIGRATION_INVALID/);
		expect(conn.statements).not.toContain(
			"CREATE TABLE a (ts TIMESTAMP, v INT)",
		);
	});
});
