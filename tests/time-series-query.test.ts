/**
 * `TimeSeriesQuery` + `SuperTableRepository.query()` unit tests (58.5) — a fake
 * `EonConnection` captures the literal SQL the builder compiles and returns
 * canned rows, asserting: the canonical windowed clause order, literal-render
 * mode (no params, escaped injection strings), the fluent subset, the thenable /
 * memoised exec ergonomics, and metadata-driven hydration (bigint/timestamp
 * revived, window aliases attached as raw extras, never `key in instance`).
 */

import "reflect-metadata";
import { describe, expect, it } from "vitest";
import type { EonConnection } from "../src/index.js";
import {
	Column,
	SuperTable,
	SuperTableRepository,
	Tag,
	TimeSeriesQuery,
	Timestamp,
} from "../src/index.js";

@SuperTable("meters")
class Meter {
	@Timestamp() declare ts: bigint;
	@Column({ type: "float" }) declare current: number;
	@Column({ type: "int" }) declare voltage: number;
	@Column({ type: "bigint" }) declare seq: bigint;
	@Tag({ type: "int" }) declare groupid: number;
	@Tag({ type: "nchar", length: 24 }) declare location: string;
}

interface FakeConn {
	conn: EonConnection;
	queries: string[];
}

/**
 * A fake connection. `query` uses an overloaded generic signature + a
 * non-generic implementation returning the concrete row type — the same no-`as`
 * trick the real `websocket.ts` uses to satisfy the generic `query<T>` seam
 * (AC10).
 */
function fakeConn(rows: Record<string, unknown>[] = []): FakeConn {
	const queries: string[] = [];
	function query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
	function query(sql: string): Promise<Record<string, unknown>[]> {
		queries.push(sql);
		return Promise.resolve(rows);
	}
	const conn: EonConnection = {
		transport: "websocket",
		exec: () => Promise.resolve({ rowsAffected: 0 }),
		query,
		ping: () => Promise.resolve(),
		ingestColumnar: () => Promise.resolve({ rowsAffected: 0 }),
		schemaless: () => Promise.resolve(),
		close: () => Promise.resolve(),
	};
	return { conn, queries };
}

describe("TimeSeriesQuery — SQL assembly", () => {
	it("compiles the full windowed query in canonical clause order, literal-only", () => {
		const { conn } = fakeConn();
		const repo = new SuperTableRepository(Meter, conn);
		const { sql, params } = repo
			.query()
			.select(["tbname", "_wstart", { fn: "avg", column: "voltage" }])
			.where("ts", ">", 1700000000000000000n)
			.partitionBy("tbname")
			.interval("1m")
			.sliding("30s")
			.fill("prev")
			.orderBy("_wstart", "asc")
			.limit(100)
			.toSQL();
		expect(sql).toBe(
			"SELECT tbname, _wstart, AVG(`voltage`) FROM `meters` WHERE `ts` > 1700000000000000000 PARTITION BY tbname INTERVAL(1m) SLIDING(30s) FILL(PREV) ORDER BY _wstart ASC LIMIT 100",
		);
		expect(params).toEqual([]);
	});

	it("renders a scalar WHERE literal-only (no params) and escapes injection strings", () => {
		const { conn } = fakeConn();
		const repo = new SuperTableRepository(Meter, conn);
		const { sql, params } = repo
			.query()
			.select(["ts"])
			.where("location", "=", "o'; DROP")
			.toSQL();
		expect(sql).toBe(
			"SELECT `ts` FROM `meters` WHERE `location` = 'o\\'; DROP'",
		);
		expect(params).toEqual([]);
	});

	it("expands IN lists and whereBetween as inline literals", () => {
		const { conn } = fakeConn();
		const repo = new SuperTableRepository(Meter, conn);
		const inSql = repo
			.query()
			.select(["ts"])
			.where("groupid", "IN", [1, 2, 3])
			.toSQL().sql;
		expect(inSql).toBe(
			"SELECT `ts` FROM `meters` WHERE `groupid` IN (1, 2, 3)",
		);
		const betweenSql = repo
			.query()
			.select(["ts"])
			.whereBetween("ts", [1000n, 2000n])
			.toSQL().sql;
		expect(betweenSql).toBe(
			"SELECT `ts` FROM `meters` WHERE `ts` >= 1000 AND `ts` <= 2000",
		);
	});

	it("defaults an unprojected query to SELECT *", () => {
		const { conn } = fakeConn();
		const repo = new SuperTableRepository(Meter, conn);
		expect(repo.query().toSQL().sql).toBe("SELECT * FROM `meters`");
	});

	it("folds where(col, null) to IS NULL / IS NOT NULL (Knex/Lucid parity)", () => {
		const { conn } = fakeConn();
		const repo = new SuperTableRepository(Meter, conn);
		expect(
			repo.query().select(["ts"]).where("location", null).toSQL().sql,
		).toBe("SELECT `ts` FROM `meters` WHERE `location` IS NULL");
		expect(
			repo.query().select(["ts"]).where("location", "!=", null).toSQL().sql,
		).toBe("SELECT `ts` FROM `meters` WHERE `location` IS NOT NULL");
	});

	it("rejects a bigint WHERE value outside the signed 64-bit range", () => {
		const { conn } = fakeConn();
		const repo = new SuperTableRepository(Meter, conn);
		expect(() =>
			repo
				.query()
				.select(["ts"])
				.where("seq", ">", 10n ** 30n)
				.toSQL(),
		).toThrow(/E_EON_PARAM_PRECISION/);
	});
});

describe("TimeSeriesQuery — execution + hydration", () => {
	const rows = (): Record<string, unknown>[] => [
		{
			ts: 1700000000000000000n,
			current: 10.5,
			voltage: 220,
			seq: 42,
			groupid: 2,
			location: "SF",
			_wstart: 1700000000000000000n,
			avg_v: 12.3,
		},
	];

	it("revives timestamp/bigint columns as bigint and leaves numeric columns", async () => {
		const { conn } = fakeConn(rows());
		const repo = new SuperTableRepository(Meter, conn);
		const [point] = await repo.query().exec();
		expect(point).toBeDefined();
		expect(typeof point?.ts).toBe("bigint");
		expect(point?.ts).toBe(1700000000000000000n);
		expect(typeof point?.seq).toBe("bigint");
		expect(point?.seq).toBe(42n);
		expect(point?.current).toBe(10.5);
		expect(point?.voltage).toBe(220);
	});

	it("revives a bigInteger-alias column (case-insensitive logical-type match)", async () => {
		@SuperTable("m2")
		class M2 {
			@Timestamp() declare ts: bigint;
			@Column({ type: "bigInteger" }) declare big: bigint;
			@Tag({ type: "int" }) declare g: number;
		}
		const { conn } = fakeConn([{ ts: 1n, big: 99, g: 1 }]);
		const repo = new SuperTableRepository(M2, conn);
		const [point] = await repo.query().exec();
		expect(typeof point?.big).toBe("bigint");
		expect(point?.big).toBe(99n);
	});

	it("query(mapPoint) projects rows into a typed shape, composed on the base hydrator", async () => {
		const { conn } = fakeConn(rows());
		const repo = new SuperTableRepository(Meter, conn);
		const points = await repo
			.query((row) => ({ id: Number(row.groupid), ts: row.ts }))
			.exec();
		const [p] = points;
		expect(p?.id).toBe(2);
		// The base hydrator runs first, so the mapper already sees a revived bigint.
		expect(typeof p?.ts).toBe("bigint");
	});

	it("attaches window pseudo-columns / aggregate aliases as raw extras", async () => {
		const { conn } = fakeConn(rows());
		const repo = new SuperTableRepository(Meter, conn);
		const [point] = await repo.query().exec();
		// `_wstart` and `avg_v` are not declared columns → attached verbatim (not
		// revived, not dropped).
		expect(point?._wstart).toBe(1700000000000000000n);
		expect(point?.avg_v).toBe(12.3);
	});

	it("revives a numeric-string bigint value", async () => {
		const { conn } = fakeConn([
			{
				ts: "1700000000000000000",
				current: 1,
				voltage: 1,
				seq: 1,
				groupid: 1,
				location: "x",
			},
		]);
		const repo = new SuperTableRepository(Meter, conn);
		const [point] = await repo.query().exec();
		expect(point?.ts).toBe(1700000000000000000n);
	});

	it("is thenable — `await query` runs exec()", async () => {
		const { conn, queries } = fakeConn(rows());
		const repo = new SuperTableRepository(Meter, conn);
		const points = await repo.query().where("groupid", 2);
		expect(points).toHaveLength(1);
		expect(queries[0]).toBe("SELECT * FROM `meters` WHERE `groupid` = 2");
	});

	it("memoises exec — repeated awaits share one round-trip", async () => {
		const { conn, queries } = fakeConn(rows());
		const query = new SuperTableRepository(Meter, conn).query();
		await query.exec();
		await query.exec();
		await query;
		expect(queries).toHaveLength(1);
	});

	it("first() applies an implicit LIMIT 1 and returns the row or null", async () => {
		const withRow = fakeConn(rows());
		const repo = new SuperTableRepository(Meter, withRow.conn);
		const point = await repo.query().first();
		expect(point).not.toBeNull();
		expect(withRow.queries[0]).toBe("SELECT * FROM `meters` LIMIT 1");

		const empty = fakeConn([]);
		const emptyRepo = new SuperTableRepository(Meter, empty.conn);
		expect(await emptyRepo.query().first()).toBeNull();
	});
});

describe("TimeSeriesQuery — standalone construction", () => {
	it("is usable directly with a connection, hydrate closure, and known-column set", async () => {
		const { conn } = fakeConn([{ ts: 5n, extra: "e" }]);
		const known = new Set(["ts"]);
		const query = new TimeSeriesQuery(
			"meters",
			conn,
			(row) => ({ ...row }),
			known,
		);
		const [point] = await query.select(["ts"]).exec();
		expect(point?.ts).toBe(5n);
		// `extra` is not in `known` → still attached by the query's raw-extra pass.
		expect(point?.extra).toBe("e");
	});
});

describe("TimeSeriesQuery — validation hardening (code review)", () => {
	const oneRow = (): Record<string, unknown>[] => [
		{ ts: 1n, current: 1, voltage: 2, seq: 3n, groupid: 2, location: "x" },
	];

	it("rejects a non-finite WHERE value (would silently become NULL)", () => {
		const { conn } = fakeConn();
		const repo = new SuperTableRepository(Meter, conn);
		expect(() =>
			repo.query().where("voltage", ">", Number.NaN).toSQL(),
		).toThrow(/E_EON_PARAM_PRECISION/);
	});

	it("rejects a non-finite FILL value", () => {
		const { conn } = fakeConn();
		const repo = new SuperTableRepository(Meter, conn);
		expect(() =>
			repo
				.query()
				.interval("1m")
				.fill("value", Number.POSITIVE_INFINITY)
				.toSQL(),
		).toThrow(/E_EON_PARAM_PRECISION/);
	});

	it("rejects limit(NaN)/limit(-1)/offset(1.5) instead of silently dropping the bound", () => {
		const { conn } = fakeConn();
		const repo = new SuperTableRepository(Meter, conn);
		expect(() => repo.query().limit(Number.NaN)).toThrow(/E_EON_INVALID_LIMIT/);
		expect(() => repo.query().limit(-1)).toThrow(/E_EON_INVALID_LIMIT/);
		expect(() => repo.query().offset(1.5)).toThrow(/E_EON_INVALID_OFFSET/);
	});

	it("keeps 2-arg and 3-arg where forms correct after the arity refactor", () => {
		const { conn } = fakeConn();
		const repo = new SuperTableRepository(Meter, conn);
		// 2-arg → `=`; 3-arg → the given operator. (An undefined 3-arg value is now a
		// compile-time type error, closing the `col = <operator>` arity trap.)
		expect(repo.query().where("groupid", 2).toSQL().sql).toContain(
			"`groupid` = 2",
		);
		expect(repo.query().where("voltage", ">", 5).toSQL().sql).toContain(
			"`voltage` > 5",
		);
	});

	it("re-executes after a mutation following an incidental await (no stale rows)", async () => {
		const { conn, queries } = fakeConn(oneRow());
		const query = new SuperTableRepository(Meter, conn).query();
		await query; // incidental await → memoises
		query.limit(10); // mutation must invalidate the memoised result
		await query; // re-executes with the new spec
		expect(queries).toHaveLength(2);
		expect(queries[1]).toContain("LIMIT 10");
	});
});
