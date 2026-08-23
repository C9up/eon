/**
 * Live windowed-query roundtrip against a real TDengine server (58.5, AC11):
 * ingest points, then run an `INTERVAL` + `PARTITION BY` + `FILL` query through
 * `SuperTableRepository.query()` and assert the window pseudo-column `_wstart`
 * comes back as a `bigint` (nanosecond timestamp) and the aggregate is mapped.
 * Gated on `EON_TEST_URL` via `describeIfTdengine` — skips in local dev, RUNS in
 * CI. Named `*.integration.test.ts` so the NAPI unit matrix excludes it.
 */

import "reflect-metadata";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { EonConnection } from "../src/index.js";
import {
	Column,
	SuperTable,
	SuperTableRepository,
	syncSuperTable,
	Tag,
	Timestamp,
} from "../src/index.js";
import {
	connectTestEon,
	describeIfTdengine,
	resetDatabase,
} from "../src/testing/index.js";

const TEST_DB = "eon_tsquery_roundtrip";

@SuperTable("meters")
class Meter {
	@Timestamp() declare ts: bigint;
	@Column({ type: "float" }) declare current: number;
	@Column({ type: "int" }) declare voltage: number;
	@Tag({ type: "int" }) declare groupid: number;
	@Tag({ type: "nchar", length: 24 }) declare location: string;
}

describeIfTdengine("eon time-series query roundtrip (live TDengine)", () => {
	let conn: EonConnection;

	beforeAll(async () => {
		conn = await connectTestEon();
		await resetDatabase(conn, TEST_DB);
		await conn.exec(`USE ${TEST_DB}`);
		await syncSuperTable(conn, Meter);
		const repo = new SuperTableRepository(Meter, conn);
		// Two one-minute buckets of readings in a single child table.
		await repo.ingestMany([
			{
				ts: 1700000000000n,
				current: 10.0,
				voltage: 219,
				groupid: 1,
				location: "SF",
			},
			{
				ts: 1700000030000n,
				current: 12.0,
				voltage: 221,
				groupid: 1,
				location: "SF",
			},
			{
				ts: 1700000090000n,
				current: 8.0,
				voltage: 210,
				groupid: 1,
				location: "SF",
			},
		]);
	}, 60_000);

	afterAll(async () => {
		if (conn) {
			await conn.exec(`DROP DATABASE IF EXISTS ${TEST_DB}`);
			await conn.close();
		}
	}, 30_000);

	it("runs a windowed query and revives _wstart as bigint", async () => {
		const repo = new SuperTableRepository(Meter, conn);
		const rows = await repo
			.query()
			.select(["_wstart", { fn: "avg", column: "voltage", as: "avg_v" }])
			// FILL needs a bounded range or TDengine rejects the query with 9787 —
			// gap-filling an unbounded window is not a thing the server will do.
			// Bounded around the fixture points above, not around "now".
			.whereBetween("ts", [1700000000000n, 1700000120000n])
			.partitionBy("tbname")
			.interval("1m")
			.fill("prev")
			.orderBy("_wstart", "asc");
		expect(rows.length).toBeGreaterThan(0);
		const first = rows[0];
		expect(first).toBeDefined();
		// The window start is a nanosecond timestamp — attached raw as a bigint.
		expect(typeof first?._wstart).toBe("bigint");
		// The aggregate alias is exposed on the mapped point.
		expect(typeof first?.avg_v).toBe("number");
	});
});
