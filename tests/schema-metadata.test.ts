import { describe, expect, it } from "vitest";
import {
	Column,
	compileCreateStableSpec,
	compileStatementNative,
	getColumnMetadata,
	getSuperTableMetadata,
	getTagMetadata,
	getTimestampColumn,
	requireSuperTableName,
	SuperTable,
	Tag,
	Timestamp,
} from "../src/index.js";

@SuperTable("meters")
class Meters {
	@Timestamp() declare ts: bigint;
	@Column({ type: "float" }) declare current: number;
	@Column({ type: "int" }) declare voltage: number;
	@Tag({ type: "int" }) declare groupid: number;
	@Tag({ type: "nchar", length: 24 }) declare location: string;
}

describe("super-table decorators + metadata getters (AC1, AC2)", () => {
	it("registers the super-table name, ts column, metric columns, and tags", () => {
		expect(getSuperTableMetadata(Meters)).toEqual({ name: "meters" });
		expect(getTimestampColumn(Meters)).toBe("ts");
		expect(getColumnMetadata(Meters).map((c) => c.propertyKey)).toEqual([
			"ts",
			"current",
			"voltage",
		]);
		expect(getTagMetadata(Meters).map((t) => t.propertyKey)).toEqual([
			"groupid",
			"location",
		]);
	});

	it("carries type/length metadata on columns and tags", () => {
		const current = getColumnMetadata(Meters).find(
			(c) => c.propertyKey === "current",
		);
		expect(current?.type).toBe("float");
		const location = getTagMetadata(Meters).find(
			(t) => t.propertyKey === "location",
		);
		expect(location).toMatchObject({ type: "nchar", length: 24 });
	});

	it("reads schema from metadata, NOT instance keys (the `declare` pitfall)", () => {
		const instance = new Meters();
		// `declare` fields are erased at runtime — `in` is always false, which is
		// exactly why every consumer must read the metadata getters.
		expect("current" in instance).toBe(false);
		expect(
			getColumnMetadata(Meters).some((c) => c.propertyKey === "current"),
		).toBe(true);
	});

	it("getters return copies (mutating the result never corrupts the registry)", () => {
		const columns = getColumnMetadata(Meters);
		columns.pop();
		expect(getColumnMetadata(Meters)).toHaveLength(3);
	});
});

describe("compileCreateStableSpec (AC6)", () => {
	it("builds a createStable spec with the ts column first", () => {
		expect(compileCreateStableSpec(Meters)).toEqual({
			kind: "createStable",
			name: "meters",
			columns: [
				{
					name: "ts",
					kind: "timestamp",
					length: null,
					precision: null,
					scale: null,
				},
				{
					name: "current",
					kind: "float",
					length: null,
					precision: null,
					scale: null,
				},
				{
					name: "voltage",
					kind: "int",
					length: null,
					precision: null,
					scale: null,
				},
			],
			tags: [
				{
					name: "groupid",
					kind: "int",
					length: null,
					precision: null,
					scale: null,
				},
				{
					name: "location",
					kind: "nchar",
					length: 24,
					precision: null,
					scale: null,
				},
			],
			ifNotExists: false,
		});
	});

	it("throws on an undecorated class", () => {
		class Plain {}
		expect(() => requireSuperTableName(Plain)).toThrowError(
			/E_EON_NOT_A_SUPERTABLE/,
		);
	});

	it("throws on an unknown/missing column type", () => {
		@SuperTable("bad")
		class Bad {
			@Timestamp() declare ts: bigint;
			@Column({ type: "nope" }) declare x: number;
			@Tag({ type: "int" }) declare g: number;
		}
		expect(() => compileCreateStableSpec(Bad)).toThrowError(/E_EON_TYPE/);
	});
});

describe("byte-exact DDL through the NAPI compiler (AC3, AC4, AC8)", () => {
	it("compiles CREATE STABLE IF NOT EXISTS from the metadata spec", () => {
		const spec = { ...compileCreateStableSpec(Meters), ifNotExists: true };
		expect(compileStatementNative(spec).statements).toEqual([
			"CREATE STABLE IF NOT EXISTS `meters` (`ts` TIMESTAMP, `current` FLOAT, `voltage` INT) TAGS (`groupid` INT, `location` NCHAR(24))",
		]);
	});

	it("compiles ALTER STABLE — one statement per change", () => {
		const result = compileStatementNative({
			kind: "alterStable",
			name: "meters",
			changes: [
				{
					op: "addColumn",
					name: "power",
					type: { kind: "float", length: null, precision: null, scale: null },
				},
				{ op: "renameTag", from: "groupid", to: "gid" },
			],
		});
		expect(result.statements).toEqual([
			"ALTER STABLE `meters` ADD COLUMN `power` FLOAT",
			"ALTER STABLE `meters` RENAME TAG `groupid` `gid`",
		]);
	});

	it("compiles an inlined-literal child table (CREATE TABLE … USING … TAGS)", () => {
		const result = compileStatementNative({
			kind: "createChildTable",
			name: "d0",
			using: "meters",
			tags: [1, "north"],
			ifNotExists: true,
			literal: true,
		});
		expect(result.statements).toEqual([
			"CREATE TABLE IF NOT EXISTS `d0` USING `meters` TAGS (1, 'north')",
		]);
		expect(result.params).toEqual([]);
	});

	it("rejects a super-table missing its first TIMESTAMP column (typed error)", () => {
		expect(() =>
			compileStatementNative({
				kind: "createStable",
				name: "bad",
				columns: [{ name: "current", kind: "float" }],
				tags: [{ name: "g", kind: "int" }],
			}),
		).toThrowError(/E_TS_REQUIRED/);
	});

	it("accepts secondary TIMESTAMP columns — only the first one is the row key", () => {
		// TDengine's rule is first-column-is-a-timestamp, not one-timestamp-only:
		// its parser checks the type of column 0 and, past that, rejects only
		// JSON. A dated fact routinely carries secondary dates — a dividend keyed
		// on its ex-date also has declaration, record and payment dates — and
		// those had to be stored as VARCHAR while this was rejected.
		const result = compileStatementNative({
			kind: "createStable",
			name: "dividends",
			columns: [
				{ name: "ex_date", kind: "timestamp" },
				{ name: "declared_at", kind: "timestamp" },
				{ name: "paid_at", kind: "timestamp" },
				{ name: "amount", kind: "decimal", precision: 28, scale: 10 },
			],
			tags: [{ name: "symbol", kind: "varchar", length: 16 }],
		});
		expect(result.statements).toEqual([
			"CREATE STABLE `dividends` (`ex_date` TIMESTAMP, `declared_at` TIMESTAMP, `paid_at` TIMESTAMP, `amount` DECIMAL(28, 10)) TAGS (`symbol` VARCHAR(16))",
		]);
	});
});

/**
 * Golden names, computed outside eon (Python hashlib) from the documented
 * encoding: SHA-256 over `eon.child.v2\0` then `<utf8 length>:<part>` for the
 * stable and each tag's `stringifyTagValue` form, first 32 hex characters.
 */
const GOLDEN_METERS_1_NORTH = "t_031da91ff5add6466e2222f61b95a541";
const GOLDEN_METERS_BIGINT = "t_e8bcbecfbe709f3030dc937a96d8358a";

describe("childTableName (AC6, D6)", () => {
	it("is deterministic for the same stable + tag-set", async () => {
		const { childTableName } = await import("../src/index.js");
		const a = childTableName("meters", [1, "north"]);
		const b = childTableName(Meters, [1, "north"]);
		expect(a).toMatch(/^t_[0-9a-f]{32}$/);
		expect(a).toBe(b);
		expect(childTableName("meters", [2, "north"])).not.toBe(a);
	});

	it("keeps a chosen tag value out of another series' child (bug 019)", async () => {
		const { childTableName } = await import("../src/index.js");
		// A computed second preimage under the former 64-bit FNV-1a naming: both
		// values mapped to `t_99df6c2806d839ff`, so the attacker's rows landed in
		// the victim's child table under the victim's tags.
		const victim = childTableName("meters", ["victim-device-42"]);
		const attacker = childTableName("meters", ["宍侻姶璂蟜蹁䏞镈皎詆蓽"]);
		expect(attacker).not.toBe(victim);
	});

	it("pins the digest encoding (golden, bug 019)", async () => {
		const { childTableName } = await import("../src/index.js");
		expect(childTableName("meters", [1, "north"])).toBe(GOLDEN_METERS_1_NORTH);
		expect(childTableName("meters", [7n, null, { a: 1 }])).toBe(
			GOLDEN_METERS_BIGINT,
		);
	});

	it("separates the stable name from the tags and the tags from each other", async () => {
		const { childTableName } = await import("../src/index.js");
		// Length-prefixed parts: moving a boundary changes the name.
		expect(childTableName("ab", ["c"])).not.toBe(childTableName("a", ["bc"]));
		expect(childTableName("m", ["a", "b"])).not.toBe(
			childTableName("m", ["a\u0000b"]),
		);
	});

	it("keeps the former FNV-1a name reachable for migrations", async () => {
		const { legacyChildTableName } = await import("../src/index.js");
		expect(legacyChildTableName("meters", ["victim-device-42"])).toBe(
			"t_99df6c2806d839ff",
		);
		expect(legacyChildTableName("meters", ["宍侻姶璂蟜蹁䏞镈皎詆蓽"])).toBe(
			"t_99df6c2806d839ff",
		);
	});
});
