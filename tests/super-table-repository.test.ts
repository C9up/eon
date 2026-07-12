/**
 * `SuperTableRepository` unit tests (58.4, AC9a) — a mocked `EonConnection`
 * asserting the EXACT ingest call shapes: the columnar (struct-of-arrays, NOT
 * row-object) STMT bind, child-table grouping, bigint timestamps, the literal
 * SQL path, the schemaless path, the fail-loud ctor, and the deliberate ABSENCE
 * of the atlas write surface TDengine has no analogue for (AC8).
 */

import "reflect-metadata";
import { describe, expect, it } from "vitest";
import type {
	EonColumnarIngest,
	EonConnection,
	EonSchemalessOptions,
} from "../src/index.js";
import {
	Column,
	SuperTable,
	SuperTableRepository,
	Tag,
	Timestamp,
} from "../src/index.js";

@SuperTable("meters")
class Meter {
	@Timestamp() declare ts: bigint;
	@Column({ type: "float" }) declare current: number;
	@Column({ type: "int" }) declare voltage: number;
	@Tag({ type: "int" }) declare groupid: number;
	@Tag({ type: "nchar", length: 24 }) declare location: string;
}

interface Captured {
	ingestColumnar: EonColumnarIngest[];
	exec: string[];
	schemaless: { lines: readonly string[]; options?: EonSchemalessOptions }[];
}

function makeConn(): { conn: EonConnection; calls: Captured } {
	const calls: Captured = { ingestColumnar: [], exec: [], schemaless: [] };
	const conn: EonConnection = {
		transport: "websocket",
		exec(sql) {
			calls.exec.push(sql);
			return Promise.resolve({ rowsAffected: 1 });
		},
		query() {
			return Promise.resolve([]);
		},
		ping() {
			return Promise.resolve();
		},
		ingestColumnar(request) {
			calls.ingestColumnar.push(request);
			const rows = request.children.reduce(
				(n, child) => n + (child.columns[0]?.values.length ?? 0),
				0,
			);
			return Promise.resolve({ rowsAffected: rows });
		},
		schemaless(lines, options) {
			calls.schemaless.push({ lines, options });
			return Promise.resolve();
		},
		close() {
			return Promise.resolve();
		},
	};
	return { conn, calls };
}

describe("SuperTableRepository — construction", () => {
	it("fails loud on a null connection (IoC injection miss)", () => {
		// Reflect.construct passes args untyped, so the runtime guard — not the
		// type system — is what we exercise here.
		expect(() =>
			Reflect.construct(SuperTableRepository, [Meter, null]),
		).toThrow(/E_EON_MISSING_CONNECTION/);
	});

	it("fails loud (not a raw TypeError) when both ctor args are null", () => {
		// A totally failed IoC injection must still surface the intended
		// E_EON_MISSING_CONNECTION, not crash on entityClass.name first.
		expect(() => Reflect.construct(SuperTableRepository, [null, null])).toThrow(
			/E_EON_MISSING_CONNECTION/,
		);
	});

	it("rejects an undecorated class", () => {
		class Plain {}
		const { conn } = makeConn();
		expect(() => new SuperTableRepository(Plain, conn)).toThrow(
			/E_EON_NOT_A_SUPERTABLE/,
		);
	});

	it("compiles the STMT prepare template from metadata (ts-first, tag cols listed)", async () => {
		const { conn, calls } = makeConn();
		const repo = new SuperTableRepository(Meter, conn);
		await repo.ingestMany([
			{ ts: 1n, current: 1, voltage: 1, groupid: 1, location: "a" },
		]);
		expect(calls.ingestColumnar[0]?.sql).toBe(
			"INSERT INTO ? USING `meters` (`groupid`, `location`) TAGS (?, ?) VALUES (?, ?, ?)",
		);
	});

	it("rejects a non-positive batchSize", () => {
		const { conn } = makeConn();
		expect(
			() => new SuperTableRepository(Meter, conn, { batchSize: 0 }),
		).toThrow(/E_EON_BATCH_SIZE/);
	});
});

describe("SuperTableRepository — columnar STMT ingest (default path)", () => {
	it("groups points by child table and binds SoA columns (never row objects)", async () => {
		const { conn, calls } = makeConn();
		const repo = new SuperTableRepository(Meter, conn);
		const result = await repo.ingestMany([
			{ ts: 1000n, current: 10.3, voltage: 219, groupid: 1, location: "SF" },
			{ ts: 2000n, current: 10.4, voltage: 220, groupid: 1, location: "SF" },
			{ ts: 3000n, current: 9.9, voltage: 210, groupid: 2, location: "LA" },
		]);
		expect(result.rowsAffected).toBe(3);

		const request = calls.ingestColumnar[0];
		expect(request).toBeDefined();
		if (!request) return;
		// Two distinct tag-sets → two child tables.
		expect(request.children).toHaveLength(2);

		const [childA, childB] = request.children;
		expect(childA?.table).not.toBe(childB?.table);

		// The (groupid=1, SF) child holds BOTH matching rows, columnar.
		const groupOne = request.children.find(
			(c) => c.columns[0]?.values.length === 2,
		);
		expect(groupOne).toBeDefined();
		if (!groupOne) return;

		// Column layout: [ts, current, voltage] with the right bind kinds.
		expect(groupOne.columns.map((c) => c.kind)).toEqual([
			"timestamp",
			"float",
			"int",
		]);
		// SoA: each column is an ARRAY of scalars, not an array of row objects.
		expect(groupOne.columns[0]?.values).toEqual([1000n, 2000n]);
		expect(groupOne.columns[1]?.values).toEqual([10.3, 10.4]);
		expect(groupOne.columns[2]?.values).toEqual([219, 220]);
		for (const column of groupOne.columns) {
			for (const value of column.values) {
				expect(typeof value).not.toBe("object");
			}
		}
		// Timestamps are bigint (the locked BigInt boundary).
		for (const value of groupOne.columns[0]?.values ?? []) {
			expect(typeof value).toBe("bigint");
		}
		// Tags: one single-element column per tag, bound before the value columns.
		expect(groupOne.tags.map((t) => t.kind)).toEqual(["int", "nchar"]);
		expect(groupOne.tags[0]?.values).toEqual([1]);
		expect(groupOne.tags[1]?.values).toEqual(["SF"]);
	});

	it("ingest() delegates to ingestMany() with a single point", async () => {
		const { conn, calls } = makeConn();
		const repo = new SuperTableRepository(Meter, conn);
		await repo.ingest({
			ts: 5n,
			current: 1,
			voltage: 2,
			groupid: 7,
			location: "X",
		});
		expect(calls.ingestColumnar).toHaveLength(1);
		expect(calls.ingestColumnar[0]?.children[0]?.columns[0]?.values).toEqual([
			5n,
		]);
	});

	it("chunks a child's rows at batchSize into multiple batches", async () => {
		const { conn, calls } = makeConn();
		const repo = new SuperTableRepository(Meter, conn, { batchSize: 2 });
		await repo.ingestMany([
			{ ts: 1n, current: 1, voltage: 1, groupid: 1, location: "SF" },
			{ ts: 2n, current: 2, voltage: 2, groupid: 1, location: "SF" },
			{ ts: 3n, current: 3, voltage: 3, groupid: 1, location: "SF" },
		]);
		const request = calls.ingestColumnar[0];
		// One child, but chunked into 2 + 1.
		expect(request?.children).toHaveLength(2);
		expect(request?.children[0]?.columns[0]?.values).toEqual([1n, 2n]);
		expect(request?.children[1]?.columns[0]?.values).toEqual([3n]);
	});

	it("rejects an unsafe-integer number timestamp (precision boundary)", async () => {
		const { conn } = makeConn();
		const repo = new SuperTableRepository(Meter, conn);
		await expect(
			repo.ingestMany([
				{ ts: 1e18, current: 1, voltage: 1, groupid: 1, location: "SF" },
			]),
		).rejects.toThrow(/E_EON_PARAM_PRECISION/);
	});

	it("accepts a safe-integer number timestamp and coerces it to bigint", async () => {
		const { conn, calls } = makeConn();
		const repo = new SuperTableRepository(Meter, conn);
		await repo.ingestMany([
			{ ts: 1700000000000, current: 1, voltage: 1, groupid: 1, location: "SF" },
		]);
		expect(calls.ingestColumnar[0]?.children[0]?.columns[0]?.values).toEqual([
			1700000000000n,
		]);
	});

	it("rejects a fractional value bound to an INT column", async () => {
		const { conn } = makeConn();
		const repo = new SuperTableRepository(Meter, conn);
		await expect(
			repo.ingestMany([
				{ ts: 1n, current: 1, voltage: 10.5, groupid: 1, location: "SF" },
			]),
		).rejects.toThrow(/E_EON_VALUE_TYPE/);
	});

	it("rejects a non-finite value bound to a FLOAT column", async () => {
		const { conn } = makeConn();
		const repo = new SuperTableRepository(Meter, conn);
		await expect(
			repo.ingestMany([
				{ ts: 1n, current: Number.NaN, voltage: 1, groupid: 1, location: "SF" },
			]),
		).rejects.toThrow(/E_EON_VALUE_TYPE/);
	});

	it("returns rowsAffected 0 and calls nothing for an empty batch", async () => {
		const { conn, calls } = makeConn();
		const repo = new SuperTableRepository(Meter, conn);
		const result = await repo.ingestMany([]);
		expect(result).toEqual({ rowsAffected: 0 });
		expect(calls.ingestColumnar).toHaveLength(0);
	});
});

describe("SuperTableRepository — literal SQL + schemaless paths", () => {
	it("ingestSql compiles a literal INSERT … USING … TAGS … VALUES per child", async () => {
		const { conn, calls } = makeConn();
		const repo = new SuperTableRepository(Meter, conn);
		const result = await repo.ingestSql([
			{
				ts: 1700000000000n,
				current: 10.3,
				voltage: 219,
				groupid: 1,
				location: "SF",
			},
		]);
		expect(result.rowsAffected).toBe(1);
		expect(calls.exec).toHaveLength(1);
		const sql = calls.exec[0] ?? "";
		expect(sql).toContain("USING `meters` TAGS (1, 'SF')");
		expect(sql).toContain("VALUES (1700000000000, 10.3, 219)");
		// No bind placeholders on the literal path.
		expect(sql).not.toContain("?");
	});

	it("ingestSql rejects a fractional timestamp (STMT-parity precision guard)", async () => {
		const { conn } = makeConn();
		const repo = new SuperTableRepository(Meter, conn);
		await expect(
			repo.ingestSql([
				{
					ts: 1700000000000.5,
					current: 10.3,
					voltage: 219,
					groupid: 1,
					location: "SF",
				},
			]),
		).rejects.toThrow(/E_EON_PARAM_PRECISION/);
	});

	it("ingestSchemaless renders InfluxDB line protocol from metadata", async () => {
		const { conn, calls } = makeConn();
		const repo = new SuperTableRepository(Meter, conn);
		await repo.ingestSchemaless([
			{
				ts: 1700000000000n,
				current: 10.3,
				voltage: 219,
				groupid: 1,
				location: "SF",
			},
		]);
		expect(calls.schemaless).toHaveLength(1);
		expect(calls.schemaless[0]?.lines).toEqual([
			"meters,groupid=1,location=SF current=10.3,voltage=219i 1700000000000",
		]);
	});
});

describe("SuperTableRepository — the atlas write surface TDengine drops (AC8)", () => {
	it("exposes none of save/upsert/firstOrCreate/updateOrCreate/useTransaction", () => {
		const { conn } = makeConn();
		const repo = new SuperTableRepository(Meter, conn);
		for (const forbidden of [
			"save",
			"saveMany",
			"upsert",
			"firstOrCreate",
			"updateOrCreate",
			"useTransaction",
		]) {
			expect(forbidden in repo).toBe(false);
		}
	});
});
