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
});

describe("childTableName (AC6, D6)", () => {
	it("is deterministic for the same stable + tag-set", async () => {
		const { childTableName } = await import("../src/index.js");
		const a = childTableName("meters", [1, "north"]);
		const b = childTableName(Meters, [1, "north"]);
		expect(a).toMatch(/^t_[0-9a-f]{16}$/);
		expect(a).toBe(b);
		expect(childTableName("meters", [2, "north"])).not.toBe(a);
	});
});
