/**
 * Schemaless line-protocol rendering unit tests (58.4, AC4) — the InfluxDB
 * escaping rules (commas / spaces / equals in tag values, quoted string fields),
 * integer `i` suffix, boolean rendering, and the no-fields rejection.
 */

import "reflect-metadata";
import { describe, expect, it } from "vitest";
import type { ColumnarPlan } from "../src/index.js";
import { toLineProtocol } from "../src/index.js";

/** A hand-built plan (no compiler needed for the schemaless renderer). */
const plan: ColumnarPlan = {
	stable: "meters",
	templateSql: "unused",
	tsProperty: "ts",
	columns: [
		{ property: "ts", kind: "timestamp" },
		{ property: "current", kind: "float" },
		{ property: "voltage", kind: "int" },
		{ property: "note", kind: "varchar" },
		{ property: "online", kind: "bool" },
	],
	tags: [
		{ property: "groupid", kind: "int" },
		{ property: "location", kind: "nchar" },
	],
	batchSize: 4096,
};

describe("toLineProtocol", () => {
	it("renders tags, typed fields, and the timestamp", () => {
		expect(
			toLineProtocol(plan, [
				{
					ts: 1700000000000n,
					current: 10.3,
					voltage: 219,
					note: "ok",
					online: true,
					groupid: 2,
					location: "SF",
				},
			]),
		).toEqual([
			'meters,groupid=2,location=SF current=10.3,voltage=219i,note="ok",online=true 1700000000000',
		]);
	});

	it("rejects an empty-string tag value (invalid line-protocol token)", () => {
		expect(() =>
			toLineProtocol(plan, [{ ts: 1n, current: 1, groupid: 1, location: "" }]),
		).toThrow(/E_EON_SCHEMALESS_EMPTY_TAG/);
	});

	it("rejects a non-boolean value bound to a bool field", () => {
		expect(() =>
			toLineProtocol(plan, [
				{ ts: 1n, current: 1, groupid: 1, location: "SF", online: 1 },
			]),
		).toThrow(/E_EON_SCHEMALESS_FIELD/);
	});

	it("rejects an object/array tag value (silent [object Object] corruption)", () => {
		expect(() =>
			toLineProtocol(plan, [
				{ ts: 1n, current: 1, groupid: 1, location: { city: "SF" } },
			]),
		).toThrow(/E_EON_SCHEMALESS_TAG/);
	});

	it("rejects an object/array value bound to a string field", () => {
		expect(() =>
			toLineProtocol(plan, [
				{ ts: 1n, current: 1, groupid: 1, location: "SF", note: ["a", "b"] },
			]),
		).toThrow(/E_EON_SCHEMALESS_FIELD/);
	});

	it("escapes commas, spaces, and equals in tag values", () => {
		expect(
			toLineProtocol(plan, [
				{
					ts: 1n,
					current: 1,
					groupid: 1,
					location: "San Francisco,CA=west",
				},
			]),
		).toEqual([
			"meters,groupid=1,location=San\\ Francisco\\,CA\\=west current=1 1",
		]);
	});

	it("quotes and escapes string field values", () => {
		expect(
			toLineProtocol(plan, [
				{ ts: 1n, note: 'a "quote" \\ slash', groupid: 1, location: "x" },
			]),
		).toEqual([
			'meters,groupid=1,location=x note="a \\"quote\\" \\\\ slash" 1',
		]);
	});

	it("omits null/undefined fields and tags", () => {
		expect(
			toLineProtocol(plan, [
				{
					ts: 5n,
					current: 1.5,
					voltage: null,
					groupid: 3,
					location: undefined,
				},
			]),
		).toEqual(["meters,groupid=3 current=1.5 5"]);
	});

	it("throws when a point has no metric fields", () => {
		expect(() =>
			toLineProtocol(plan, [{ ts: 1n, groupid: 1, location: "x" }]),
		).toThrow(/E_EON_SCHEMALESS_NO_FIELDS/);
	});

	// --- injection / corruption hardening (code review) ---

	it("rejects a newline in a tag value (line-protocol injection)", () => {
		expect(() =>
			toLineProtocol(plan, [
				{ ts: 1n, current: 1, location: "SF\nmeters,groupid=99 x=1i 2" },
			]),
		).toThrow(/E_EON_SCHEMALESS_CONTROL_CHAR/);
	});

	it("rejects a newline in a string field value (line-protocol injection)", () => {
		expect(() =>
			toLineProtocol(plan, [{ ts: 1n, note: "a\ninjected,x=1 f=1i 2" }]),
		).toThrow(/E_EON_SCHEMALESS_CONTROL_CHAR/);
	});

	it("escapes a trailing backslash in a tag value (no delimiter desync)", () => {
		expect(
			toLineProtocol(plan, [
				{ ts: 1n, current: 1, groupid: 1, location: "SF\\" },
			]),
		).toEqual(["meters,groupid=1,location=SF\\\\ current=1 1"]);
	});

	it("rejects an unsafe-integer int field (precision loss)", () => {
		expect(() =>
			toLineProtocol(plan, [{ ts: 1n, voltage: Number.MAX_SAFE_INTEGER + 1 }]),
		).toThrow(/E_EON_PARAM_PRECISION/);
	});

	it("rejects a non-finite float field", () => {
		expect(() =>
			toLineProtocol(plan, [{ ts: 1n, current: Number.POSITIVE_INFINITY }]),
		).toThrow(/E_EON_SCHEMALESS_FIELD/);
	});

	it("rejects an empty measurement", () => {
		expect(() =>
			toLineProtocol({ ...plan, stable: "" }, [{ ts: 1n, current: 1 }]),
		).toThrow(/E_EON_SCHEMALESS_MEASUREMENT/);
	});
});
