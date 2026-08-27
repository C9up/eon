import { describe, expect, it } from "vitest";
import { EonSchema, Migration } from "../src/index.js";

describe("EonSchema — create stable", () => {
	it("builds a CREATE STABLE with ts-first columns, tags, and IF NOT EXISTS", () => {
		const schema = new EonSchema();
		schema.createStable("meters", (t) => {
			t.timestamp("ts");
			t.float("current");
			t.int("voltage");
			t.varchar("phase", 16);
			t.int("groupid").tag();
			t.nchar("location", 24).tag();
		});
		expect(schema.toSQL()).toEqual([
			"CREATE STABLE IF NOT EXISTS `meters` (`ts` TIMESTAMP, `current` FLOAT, `voltage` INT, `phase` VARCHAR(16)) TAGS (`groupid` INT, `location` NCHAR(24))",
		]);
	});

	it("treats a repeated .tag() on the same column as idempotent", () => {
		const schema = new EonSchema();
		schema.createStable("meters", (t) => {
			t.timestamp("ts");
			t.float("current");
			const g = t.int("groupid");
			g.tag();
			g.tag(); // second call must NOT push a duplicate tag
		});
		expect(schema.toSQL()).toEqual([
			"CREATE STABLE IF NOT EXISTS `meters` (`ts` TIMESTAMP, `current` FLOAT) TAGS (`groupid` INT)",
		]);
	});

	it("emits a KEEP retention trailer when given", () => {
		const schema = new EonSchema();
		schema.createStable(
			"meters",
			(t) => {
				t.timestamp("ts");
				t.float("current");
				t.int("groupid").tag();
			},
			{ keep: "30d" },
		);
		expect(schema.toSQL()[0]).toMatch(/\) KEEP 30d$/);
	});

	it("supports a non-idempotent CREATE STABLE via ifNotExists:false", () => {
		const schema = new EonSchema();
		schema.createStable(
			"meters",
			(t) => {
				t.timestamp("ts");
				t.double("power");
				t.int("g").tag();
			},
			{ ifNotExists: false },
		);
		expect(schema.toSQL()[0]).toBe(
			"CREATE STABLE `meters` (`ts` TIMESTAMP, `power` DOUBLE) TAGS (`g` INT)",
		);
	});

	it("supports decimal precision/scale and json tag", () => {
		const schema = new EonSchema();
		schema.createStable("readings", (t) => {
			t.timestamp("ts");
			t.decimal("amount", 12, 4);
			t.json("meta").tag();
		});
		expect(schema.toSQL()[0]).toBe(
			"CREATE STABLE IF NOT EXISTS `readings` (`ts` TIMESTAMP, `amount` DECIMAL(12, 4)) TAGS (`meta` JSON)",
		);
	});
});

describe("EonSchema — alter stable", () => {
	it("emits one statement per change", () => {
		const schema = new EonSchema();
		schema.alterStable("meters", (t) => {
			t.addColumn("power").int();
			t.dropColumn("phase");
			t.modifyColumn("note").varchar(64);
			t.addTag("region").nchar(8);
			t.dropTag("location");
			t.renameTag("groupid", "gid");
		});
		expect(schema.toSQL()).toEqual([
			"ALTER STABLE `meters` ADD COLUMN `power` INT",
			"ALTER STABLE `meters` DROP COLUMN `phase`",
			"ALTER STABLE `meters` MODIFY COLUMN `note` VARCHAR(64)",
			"ALTER STABLE `meters` ADD TAG `region` NCHAR(8)",
			"ALTER STABLE `meters` DROP TAG `location`",
			"ALTER STABLE `meters` RENAME TAG `groupid` `gid`",
		]);
	});
});

describe("EonSchema — database DDL (retention)", () => {
	it("builds CREATE DATABASE with options in stable order", () => {
		const schema = new EonSchema();
		schema.createDatabase("metrics", {
			keep: "90d",
			duration: "10d",
			precision: "ms",
			buffer: 256,
			walLevel: 1,
			cachemodel: "last_row",
		});
		expect(schema.toSQL()[0]).toBe(
			"CREATE DATABASE IF NOT EXISTS `metrics` KEEP 90d DURATION 10d PRECISION 'ms' BUFFER 256 WAL_LEVEL 1 CACHEMODEL 'last_row'",
		);
	});

	it("builds a bare CREATE DATABASE", () => {
		const schema = new EonSchema();
		schema.createDatabase("metrics");
		expect(schema.toSQL()[0]).toBe("CREATE DATABASE IF NOT EXISTS `metrics`");
	});

	it("alters a single database option", () => {
		const schema = new EonSchema();
		schema.alterDatabase("metrics", { keep: "60d" });
		expect(schema.toSQL()[0]).toBe("ALTER DATABASE `metrics` KEEP 60d");
	});

	it("maps walLevel to the WAL_LEVEL option on alter", () => {
		const schema = new EonSchema();
		schema.alterDatabase("metrics", { walLevel: 2 });
		expect(schema.toSQL()[0]).toBe("ALTER DATABASE `metrics` WAL_LEVEL 2");
	});

	it("rejects an alterDatabase with zero or multiple options", () => {
		const schema = new EonSchema();
		expect(() => schema.alterDatabase("metrics", {})).toThrow(
			/exactly one option/,
		);
		expect(() =>
			schema.alterDatabase("metrics", { keep: "60d", buffer: 128 }),
		).toThrow(/exactly one option/);
	});

	it("rejects KEEP < 3x DURATION at compile time", () => {
		const schema = new EonSchema();
		expect(() =>
			schema.createDatabase("metrics", { keep: "20d", duration: "10d" }),
		).toThrow(/E_EON_KEEP_TOO_SMALL/);
	});
});

describe("EonSchema — basic table DDL", () => {
	it("builds a CREATE TABLE (no tags) and DROP TABLE", () => {
		const schema = new EonSchema();
		schema.createTable("ream_eon_migrations", (t) => {
			t.timestamp("executed_at");
			t.varchar("name", 255);
			t.int("batch");
		});
		schema.dropTable("ream_eon_migrations");
		expect(schema.toSQL()).toEqual([
			"CREATE TABLE IF NOT EXISTS `ream_eon_migrations` (`executed_at` TIMESTAMP, `name` VARCHAR(255), `batch` INT)",
			"DROP TABLE IF EXISTS `ream_eon_migrations`",
		]);
	});
});

describe("Migration base class", () => {
	class CreateMeters extends Migration {
		up(): void {
			this.schema.createDatabase("metrics", { keep: "90d", duration: "10d" });
			this.schema.createStable("meters", (t) => {
				t.timestamp("ts");
				t.float("current");
				t.int("groupid").tag();
			});
		}
		down(): void {
			this.schema.dropStable("meters");
		}
	}

	it("getUpSQL replays up() and collects compiled SQL", async () => {
		const migration = new CreateMeters();
		expect(await migration.getUpSQL()).toEqual([
			"CREATE DATABASE IF NOT EXISTS `metrics` KEEP 90d DURATION 10d",
			"CREATE STABLE IF NOT EXISTS `meters` (`ts` TIMESTAMP, `current` FLOAT) TAGS (`groupid` INT)",
		]);
	});

	it("getDownSQL replays down() independently and resets between runs", async () => {
		const migration = new CreateMeters();
		await migration.getUpSQL();
		expect(await migration.getDownSQL()).toEqual([
			"DROP STABLE IF EXISTS `meters`",
		]);
	});

	it("raw() queues a verbatim statement", async () => {
		class Raw extends Migration {
			up(): void {
				this.raw("FLUSH DATABASE metrics");
			}
			down(): void {}
		}
		expect(await new Raw().getUpSQL()).toEqual(["FLUSH DATABASE metrics"]);
	});
});
