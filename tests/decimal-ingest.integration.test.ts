/**
 * DECIMAL, across the three ingest paths, against a live server.
 *
 * The columnar STMT path stores an unrelated number for a decimal — not a
 * rounding, a different value on every run — because `@tdengine/websocket`
 * 3.5.0 mis-binds it. Reproduced with the connector's own API and no eon code
 * in the path, so eon refuses that combination rather than writing a wrong
 * price without complaint. These tests pin both halves: the refusal, and the
 * path that was measured exact.
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

const TEST_DB = "eon_decimal_ingest";

@SuperTable("prices")
class Price {
	@Timestamp() declare ts: bigint;
	@Column({ type: "decimal", precision: 20, scale: 10 }) declare amount: string;
	@Tag({ type: "nchar", length: 16 }) declare symbol: string;
}

/** No decimal anywhere — the columnar path must stay open for it. */
@SuperTable("meters")
class Meter {
	@Timestamp() declare ts: bigint;
	@Column({ type: "double" }) declare current: number;
	@Tag({ type: "nchar", length: 16 }) declare location: string;
}

describeIfTdengine("eon decimal ingest (live TDengine)", () => {
	let conn: EonConnection;

	beforeAll(async () => {
		conn = await connectTestEon();
		await resetDatabase(conn, TEST_DB);
		await conn.exec(`USE ${TEST_DB}`);
		await syncSuperTable(conn, Price);
		await syncSuperTable(conn, Meter);
	}, 60_000);

	afterAll(async () => {
		if (conn) {
			await conn.exec(`DROP DATABASE IF EXISTS ${TEST_DB}`);
			await conn.close();
		}
	}, 30_000);

	it("refuses the columnar path, naming the column and the way through", async () => {
		const repo = new SuperTableRepository(Price, conn);

		await expect(
			repo.ingestMany([
				{ ts: 1700000000000n, amount: "61.99", symbol: "ACME" },
			]),
		).rejects.toThrow(/E_EON_DECIMAL_STMT.*amount.*ingestSql/s);
	});

	it("round-trips a decimal exactly through the literal path", async () => {
		const repo = new SuperTableRepository(Price, conn);
		await repo.ingestSql([
			{ ts: 1700000001000n, amount: "61.99", symbol: "BETA" },
		]);

		const rows = await conn.query<{ amount: string }>(
			"SELECT amount FROM prices WHERE ts = 1700000001000",
		);
		// The whole point: the digits that went in are the digits that come out.
		expect(rows[0]?.amount).toBe("61.9900000000");
	});

	it("leaves the columnar path open for a super-table without a decimal", async () => {
		const repo = new SuperTableRepository(Meter, conn);

		const result = await repo.ingestMany([
			{ ts: 1700000002000n, current: 10.5, location: "SF" },
		]);

		expect(result.rowsAffected).toBe(1);
	});
});
