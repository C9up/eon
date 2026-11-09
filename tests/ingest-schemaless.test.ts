/**
 * Schemaless line-protocol rendering unit tests (58.4, AC4) — the InfluxDB
 * escaping rules (commas / spaces / equals in tag values, quoted string fields),
 * the per-kind type suffixes, boolean rendering, the no-fields rejection, and
 * the refusal of an entity whose schema the line protocol cannot write.
 */

import "reflect-metadata";
import { describe, expect, it } from "vitest";
import type { ColumnarPlan } from "../src/index.js";
import { toLineProtocol } from "../src/index.js";

/** A hand-built plan (no compiler needed for the schemaless renderer). */
const plan: ColumnarPlan = {
	stable: "meters",
	templateSql: "unused",
	tsProperty: "_ts",
	columns: [
		{ property: "_ts", kind: "timestamp" },
		{ property: "current", kind: "float" },
		{ property: "voltage", kind: "int" },
		{ property: "note", kind: "varchar" },
		{ property: "online", kind: "bool" },
	],
	tags: [
		{ property: "groupid", kind: "nchar" },
		{ property: "location", kind: "nchar" },
	],
	batchSize: 4096,
};

describe("toLineProtocol", () => {
	it("renders tags, typed fields, and the timestamp", () => {
		expect(
			toLineProtocol(plan, [
				{
					_ts: 1700000000000n,
					current: 10.3,
					voltage: 219,
					note: "ok",
					online: true,
					groupid: 2,
					location: "SF",
				},
			]),
		).toEqual([
			'meters,groupid=2,location=SF current=10.3f32,voltage=219i32,note="ok",online=true 1700000000000',
		]);
	});

	it("rejects an empty-string tag value (invalid line-protocol token)", () => {
		expect(() =>
			toLineProtocol(plan, [{ _ts: 1n, current: 1, groupid: 1, location: "" }]),
		).toThrow(/E_EON_SCHEMALESS_EMPTY_TAG/);
	});

	it("rejects a non-boolean value bound to a bool field", () => {
		expect(() =>
			toLineProtocol(plan, [
				{ _ts: 1n, current: 1, groupid: 1, location: "SF", online: 1 },
			]),
		).toThrow(/E_EON_SCHEMALESS_FIELD/);
	});

	it("rejects an object/array tag value (silent [object Object] corruption)", () => {
		expect(() =>
			toLineProtocol(plan, [
				{ _ts: 1n, current: 1, groupid: 1, location: { city: "SF" } },
			]),
		).toThrow(/E_EON_SCHEMALESS_TAG/);
	});

	it("rejects an object/array value bound to a string field", () => {
		expect(() =>
			toLineProtocol(plan, [
				{ _ts: 1n, current: 1, groupid: 1, location: "SF", note: ["a", "b"] },
			]),
		).toThrow(/E_EON_SCHEMALESS_FIELD/);
	});

	it("escapes commas, spaces, and equals in tag values", () => {
		expect(
			toLineProtocol(plan, [
				{
					_ts: 1n,
					current: 1,
					groupid: 1,
					location: "San Francisco,CA=west",
				},
			]),
		).toEqual([
			"meters,groupid=1,location=San\\ Francisco\\,CA\\=west current=1f32 1",
		]);
	});

	it("quotes and escapes string field values", () => {
		expect(
			toLineProtocol(plan, [
				{ _ts: 1n, note: 'a "quote" \\ slash', groupid: 1, location: "x" },
			]),
		).toEqual([
			'meters,groupid=1,location=x note="a \\"quote\\" \\\\ slash" 1',
		]);
	});

	it("omits null/undefined fields and tags", () => {
		expect(
			toLineProtocol(plan, [
				{
					_ts: 5n,
					current: 1.5,
					voltage: null,
					groupid: 3,
					location: undefined,
				},
			]),
		).toEqual(["meters,groupid=3 current=1.5f32 5"]);
	});

	it("throws when a point has no metric fields", () => {
		expect(() =>
			toLineProtocol(plan, [{ _ts: 1n, groupid: 1, location: "x" }]),
		).toThrow(/E_EON_SCHEMALESS_NO_FIELDS/);
	});

	// --- injection / corruption hardening (code review) ---

	it("rejects a newline in a tag value (line-protocol injection)", () => {
		expect(() =>
			toLineProtocol(plan, [
				{ _ts: 1n, current: 1, location: "SF\nmeters,groupid=99 x=1i 2" },
			]),
		).toThrow(/E_EON_SCHEMALESS_CONTROL_CHAR/);
	});

	it("rejects a newline in a string field value (line-protocol injection)", () => {
		expect(() =>
			toLineProtocol(plan, [{ _ts: 1n, note: "a\ninjected,x=1 f=1i 2" }]),
		).toThrow(/E_EON_SCHEMALESS_CONTROL_CHAR/);
	});

	it("escapes a trailing backslash in a tag value (no delimiter desync)", () => {
		expect(
			toLineProtocol(plan, [
				{ _ts: 1n, current: 1, groupid: 1, location: "SF\\" },
			]),
		).toEqual(["meters,groupid=1,location=SF\\\\ current=1f32 1"]);
	});

	it("rejects an unsafe-integer int field (precision loss)", () => {
		expect(() =>
			toLineProtocol(plan, [{ _ts: 1n, voltage: Number.MAX_SAFE_INTEGER + 1 }]),
		).toThrow(/E_EON_PARAM_PRECISION/);
	});

	it("rejects a non-finite float field", () => {
		expect(() =>
			toLineProtocol(plan, [{ _ts: 1n, current: Number.POSITIVE_INFINITY }]),
		).toThrow(/E_EON_SCHEMALESS_FIELD/);
	});

	it("rejects an out-of-range integer field (i32 overflow → silent wrap)", () => {
		// voltage is `int` (i32); 5e9 is a safe JS integer but overflows i32.
		expect(() =>
			toLineProtocol(plan, [{ _ts: 1n, voltage: 5_000_000_000 }]),
		).toThrow(/E_EON_SCHEMALESS_FIELD/);
	});

	it("rejects a float field beyond the binary32 range (would render Infinity)", () => {
		expect(() => toLineProtocol(plan, [{ _ts: 1n, current: 3.4e40 }])).toThrow(
			/E_EON_SCHEMALESS_FIELD/,
		);
	});

	it("rejects an empty measurement", () => {
		expect(() =>
			toLineProtocol({ ...plan, stable: "" }, [{ _ts: 1n, current: 1 }]),
		).toThrow(/E_EON_SCHEMALESS_MEASUREMENT/);
	});

	it("gives every numeric kind its own type suffix and NCHAR its L prefix", () => {
		const typed: ColumnarPlan = {
			...plan,
			columns: [
				{ property: "_ts", kind: "timestamp" },
				{ property: "a", kind: "tinyInt" },
				{ property: "b", kind: "smallInt" },
				{ property: "c", kind: "int" },
				{ property: "d", kind: "bigInt" },
				{ property: "e", kind: "float" },
				{ property: "f", kind: "double" },
				{ property: "g", kind: "varchar" },
				{ property: "h", kind: "nchar" },
			],
			tags: [{ property: "site", kind: "nchar" }],
		};
		expect(
			toLineProtocol(typed, [
				{
					_ts: 1n,
					a: 1,
					b: 2,
					c: 3,
					d: 4n,
					e: 1.5,
					f: 2.5,
					g: "v",
					h: "wörld",
					site: "x",
				},
			]),
		).toEqual([
			'meters,site=x a=1i8,b=2i16,c=3i32,d=4i64,e=1.5f32,f=2.5f64,g="v",h=L"wörld" 1',
		]);
	});

	describe("refuses a schema the line protocol cannot write", () => {
		const cases: { label: string; override: Partial<ColumnarPlan> }[] = [
			{
				label: "a VARCHAR tag",
				override: { tags: [{ property: "site", kind: "varchar" }] },
			},
			{
				label: "an INT tag",
				override: { tags: [{ property: "site", kind: "int" }] },
			},
			{
				label: "a timestamp not named _ts",
				override: {
					tsProperty: "ts",
					columns: [
						{ property: "ts", kind: "timestamp" },
						{ property: "n", kind: "int" },
					],
				},
			},
			{
				label: "a second timestamp column",
				override: {
					columns: [
						{ property: "_ts", kind: "timestamp" },
						{ property: "seen", kind: "timestamp" },
					],
				},
			},
			{
				label: "a VARBINARY column",
				override: {
					columns: [
						{ property: "_ts", kind: "timestamp" },
						{ property: "raw", kind: "varbinary" },
					],
				},
			},
			{
				label: "a JSON column",
				override: {
					columns: [
						{ property: "_ts", kind: "timestamp" },
						{ property: "doc", kind: "json" },
					],
				},
			},
			{
				label: "a DECIMAL column",
				override: {
					columns: [
						{ property: "_ts", kind: "timestamp" },
						{ property: "amount", kind: "decimal" },
					],
				},
			},
		];
		it.each(cases)("$label", ({ override }) => {
			const refused: ColumnarPlan = { ...plan, ...override };
			expect(() =>
				toLineProtocol(refused, [
					{
						_ts: 1n,
						ts: 1n,
						n: 1,
						site: "x",
						seen: 1n,
						raw: "a",
						doc: "{}",
						amount: 1,
					},
				]),
			).toThrow(/E_EON_SCHEMALESS_SCHEMA/);
		});
	});
});
