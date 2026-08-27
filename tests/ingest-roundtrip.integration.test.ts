/**
 * Live ingest roundtrip against a real TDengine server (58.4, AC9c): each of the
 * three ingest paths (STMT columnar, literal SQL, schemaless line protocol)
 * writes points and reads them back via `SELECT COUNT(*)`. Gated on
 * `EON_TEST_URL` via `describeIfTdengine` — skips in local dev without a server,
 * RUNS in CI where the docker server is present. Named `*.integration.test.ts`
 * so the NAPI unit matrix excludes it.
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
import { connectTestEon, resetDatabase } from "../src/testing/index.js";
import { describeIfTdengine } from "../src/testing/vitest.js";

const TEST_DB = "eon_ingest_roundtrip";

@SuperTable("meters")
class Meter {
	@Timestamp() declare ts: bigint;
	@Column({ type: "float" }) declare current: number;
	@Column({ type: "int" }) declare voltage: number;
	@Tag({ type: "int" }) declare groupid: number;
	@Tag({ type: "nchar", length: 24 }) declare location: string;
}

/** A separate schemaless-only measurement: the line protocol auto-creates it. */
@SuperTable("sl_meters")
class SlMeter {
	@Timestamp() declare ts: bigint;
	@Column({ type: "double" }) declare current: number;
	@Tag({ type: "nchar", length: 24 }) declare location: string;
}

describeIfTdengine("eon ingest roundtrip (live TDengine)", () => {
	let conn: EonConnection;

	beforeAll(async () => {
		conn = await connectTestEon();
		await resetDatabase(conn, TEST_DB);
		await conn.exec(`USE ${TEST_DB}`);
		await syncSuperTable(conn, Meter);
	}, 60_000);

	afterAll(async () => {
		if (conn) {
			await conn.exec(`DROP DATABASE IF EXISTS ${TEST_DB}`);
			await conn.close();
		}
	}, 30_000);

	async function count(stable: string): Promise<number> {
		const rows = await conn.query<{ n: bigint | number }>(
			`SELECT COUNT(*) AS n FROM ${stable}`,
		);
		return Number(rows[0]?.n ?? 0);
	}

	it("STMT columnar path inserts across two child tables and reads them back", async () => {
		const repo = new SuperTableRepository(Meter, conn);
		const before = await count("meters");
		const result = await repo.ingestMany([
			{
				ts: 1700000000000n,
				current: 10.3,
				voltage: 219,
				groupid: 1,
				location: "SF",
			},
			{
				ts: 1700000000001n,
				current: 10.4,
				voltage: 220,
				groupid: 1,
				location: "SF",
			},
			{
				ts: 1700000000002n,
				current: 9.9,
				voltage: 210,
				groupid: 2,
				location: "LA",
			},
		]);
		expect(result.rowsAffected).toBe(3);
		expect(await count("meters")).toBe(before + 3);
	});

	it("literal SQL path inserts via exec and reads back", async () => {
		const repo = new SuperTableRepository(Meter, conn);
		const before = await count("meters");
		const result = await repo.ingestSql([
			{
				ts: 1700000001000n,
				current: 1.1,
				voltage: 100,
				groupid: 3,
				location: "NY",
			},
		]);
		expect(result.rowsAffected).toBe(1);
		expect(await count("meters")).toBe(before + 1);
	});

	it("schemaless path auto-creates the measurement and reads back", async () => {
		const repo = new SuperTableRepository(SlMeter, conn);
		await repo.ingestSchemaless([
			{ ts: 1700000002000n, current: 5.5, location: "SF" },
			{ ts: 1700000002001n, current: 5.6, location: "LA" },
		]);
		expect(await count("sl_meters")).toBe(2);
	});
});
