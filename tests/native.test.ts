import { describe, expect, it } from "vitest";
import { compileStatementNative, quoteIdentNative } from "../src/index.js";

describe("compileStatementNative — NAPI round-trip", () => {
	it("compiles a plain INSERT to parameterised TDengine SQL", () => {
		const result = compileStatementNative({
			kind: "insert",
			table: "child",
			columns: ["ts", "current"],
			rows: [[1700000000000, 10.3]],
		});
		expect(result.statements).toEqual([
			"INSERT INTO `child` (`ts`, `current`) VALUES (?, ?)",
		]);
		expect(result.params).toEqual([1700000000000, 10.3]);
	});

	it("compiles a child-table auto-create INSERT (USING…TAGS), tags bound first", () => {
		const result = compileStatementNative({
			kind: "insert",
			table: "child",
			using: "meters",
			tags: ["California.SanFrancisco"],
			columns: ["ts", "current"],
			rows: [[1700000000000, 10.3]],
		});
		expect(result.statements).toEqual([
			"INSERT INTO `child` USING `meters` TAGS (?) (`ts`, `current`) VALUES (?, ?)",
		]);
		expect(result.params).toEqual([
			"California.SanFrancisco",
			1700000000000,
			10.3,
		]);
	});

	it("compiles a basic SELECT with WHERE + LIMIT", () => {
		const result = compileStatementNative({
			kind: "select",
			table: "meters",
			select: ["ts", "current"],
			wheres: [{ column: "groupid", operator: "=", value: 2 }],
			limit: 10,
		});
		expect(result.statements).toEqual([
			"SELECT `ts`, `current` FROM `meters` WHERE `groupid` = ? LIMIT 10",
		]);
		expect(result.params).toEqual([2]);
	});

	it("compiles a time-window clause through the extended compiler (58.5)", () => {
		const result = compileStatementNative({
			kind: "select",
			table: "meters",
			select: ["_wstart"],
			interval: "1m",
		});
		expect(result.statements).toEqual([
			"SELECT _wstart FROM `meters` INTERVAL(1m)",
		]);
		expect(result.params).toEqual([]);
	});

	it("rejects an unsafe identifier at the seam (never emits SQL)", () => {
		expect(() =>
			compileStatementNative({
				kind: "select",
				table: "meters`; DROP TABLE x",
			}),
		).toThrowError(/E_UNSAFE_IDENTIFIER/);
	});

	it("preserves an i64 / nanosecond bigint param losslessly across the boundary", () => {
		const ns = 1700000000000000000n;
		const result = compileStatementNative({
			kind: "insert",
			table: "child",
			columns: ["ts", "current"],
			rows: [[ns, 10.3]],
		});
		expect(result.statements).toEqual([
			"INSERT INTO `child` (`ts`, `current`) VALUES (?, ?)",
		]);
		expect(result.params).toEqual([ns, 10.3]);
	});

	it("rejects an already-lossy unsafe-integer number param (loud, not silent)", () => {
		expect(() =>
			compileStatementNative({
				kind: "insert",
				table: "child",
				columns: ["ts"],
				rows: [[1e18]],
			}),
		).toThrowError(/E_EON_PARAM_PRECISION/);
	});

	it("quoteIdentNative backtick-quotes and rejects injection", () => {
		expect(quoteIdentNative("meters")).toBe("`meters`");
		expect(() => quoteIdentNative("m`; DROP")).toThrowError(
			/E_UNSAFE_IDENTIFIER/,
		);
	});

	// ── 58.4 ingest compiler modes (AC9b) ──────────────────────────

	it("compiles the STMT prepare template (table `?`, one `?` per column, no params)", () => {
		const result = compileStatementNative({
			kind: "stmtInsertTemplate",
			using: "meters",
			tagColumns: ["groupid", "location"],
			columns: ["ts", "current", "voltage"],
		});
		expect(result.statements).toEqual([
			"INSERT INTO ? USING `meters` (`groupid`, `location`) TAGS (?, ?) VALUES (?, ?, ?)",
		]);
		expect(result.params).toEqual([]);
	});

	it("rejects injection in a STMT template identifier (never emits SQL)", () => {
		expect(() =>
			compileStatementNative({
				kind: "stmtInsertTemplate",
				using: "meters`; DROP",
				tagColumns: ["g"],
				columns: ["ts"],
			}),
		).toThrowError(/E_UNSAFE_IDENTIFIER/);
	});

	it("compiles a literal INSERT (values inlined, escaped, no params)", () => {
		const result = compileStatementNative({
			kind: "insert",
			table: "d0",
			using: "meters",
			tags: [1, "Cali'fornia"],
			columns: ["ts", "current"],
			rows: [[1700000000000n, 10.3]],
			literal: true,
		});
		expect(result.statements).toEqual([
			"INSERT INTO `d0` USING `meters` TAGS (1, 'Cali\\'fornia') (`ts`, `current`) VALUES (1700000000000, 10.3)",
		]);
		expect(result.params).toEqual([]);
	});
});
