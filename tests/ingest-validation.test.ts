/**
 * STMT / literal ingest value-validation unit tests (code review, chunk B):
 * per-width integer bounds, f32 overflow, object-into-scalar rejection,
 * literal-path tag validation, and object/JSON tag child-grouping equality.
 */

import "reflect-metadata";
import { describe, expect, it } from "vitest";
import type { ColumnarPlan } from "../src/index.js";
import { buildLiteralInserts, groupByChild } from "../src/index.js";
import { assertColumnValue } from "../src/ingest/stmt.js";

describe("assertColumnValue — integer width bounds (F1)", () => {
	it("rejects a safe integer that overflows the column width", () => {
		expect(() => assertColumnValue(300, "tinyInt", "x")).toThrow(
			/E_EON_VALUE_RANGE/,
		);
		expect(() => assertColumnValue(70000, "smallInt", "x")).toThrow(
			/E_EON_VALUE_RANGE/,
		);
		expect(() => assertColumnValue(5_000_000_000, "int", "x")).toThrow(
			/E_EON_VALUE_RANGE/,
		);
		expect(() => assertColumnValue(2n ** 70n, "bigInt", "x")).toThrow(
			/E_EON_VALUE_RANGE/,
		);
	});

	it("accepts in-range values incl. the i64 boundary", () => {
		expect(() => assertColumnValue(127, "tinyInt", "x")).not.toThrow();
		expect(() => assertColumnValue(-128, "tinyInt", "x")).not.toThrow();
		expect(() =>
			assertColumnValue(9223372036854775807n, "bigInt", "x"),
		).not.toThrow();
	});
});

describe("assertColumnValue — float f32 range (F1)", () => {
	it("rejects a double beyond binary32 for a FLOAT column but allows DOUBLE", () => {
		expect(() => assertColumnValue(3.4e40, "float", "x")).toThrow(
			/E_EON_VALUE_RANGE/,
		);
		expect(() => assertColumnValue(3.4e40, "double", "x")).not.toThrow();
	});
});

describe("assertColumnValue — scalar/object (F2)", () => {
	it("rejects an object bound to a string/binary column", () => {
		expect(() => assertColumnValue({ a: 1 }, "varchar", "x")).toThrow(
			/E_EON_VALUE_TYPE/,
		);
	});

	it("allows an object for a JSON column", () => {
		expect(() => assertColumnValue({ a: 1 }, "json", "x")).not.toThrow();
	});
});

const litPlan: ColumnarPlan = {
	stable: "meters",
	templateSql: "unused",
	tsProperty: "ts",
	columns: [
		{ property: "ts", kind: "timestamp" },
		{ property: "voltage", kind: "int" },
	],
	tags: [{ property: "groupid", kind: "int" }],
	batchSize: 4096,
};

describe("buildLiteralInserts — literal tag validation (F3)", () => {
	it("rejects a fractional value on an integer @Tag", () => {
		expect(() =>
			buildLiteralInserts(litPlan, [
				{ ts: 1700000000000n, voltage: 1, groupid: 1.5 },
			]),
		).toThrow(/E_EON_VALUE_TYPE/);
	});
});

describe("groupByChild — object/JSON tag equality (F5)", () => {
	it("does not false-collide two structurally-equal object tags", () => {
		// Distinct object references that stringify identically must map to ONE
		// child, not trip E_EON_CHILD_COLLISION.
		const groups = groupByChild(
			"meters",
			["meta"],
			[
				{ ts: 1n, meta: { region: "west" } },
				{ ts: 2n, meta: { region: "west" } },
			],
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.rows).toHaveLength(2);
	});
});
