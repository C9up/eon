/**
 * DECIMAL, across the ingest paths, against a live server.
 *
 * The driver eon used before (`@tdengine/websocket` 3.5.0) bound a decimal
 * through stmt2 as its text, which the server read as raw bytes: an unrelated
 * number, a different one every run, so eon refused the columnar path for a
 * decimal. eon's own client binds the unscaled integer at the column's scale;
 * these tests pin that the digits that go in are the digits that come out, on
 * both DECIMAL widths, and that a value the column cannot hold is refused
 * rather than rounded.
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

/** DECIMAL(10,4): a DECIMAL64 on the server. */
@SuperTable("rates")
class Rate {
	@Timestamp() declare ts: bigint;
	@Column({ type: "decimal", precision: 10, scale: 4 }) declare rate: string;
	@Tag({ type: "nchar", length: 16 }) declare pair: string;
}

/** No decimal anywhere. */
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
		await syncSuperTable(conn, Rate);
	}, 60_000);

	afterAll(async () => {
		if (conn) {
			await conn.exec(`DROP DATABASE IF EXISTS ${TEST_DB}`);
			await conn.close();
		}
	}, 30_000);

	it("round-trips a decimal exactly through the columnar path", async () => {
		const repo = new SuperTableRepository(Price, conn);
		await repo.ingestMany([
			{ ts: 1700000000000n, amount: "61.99", symbol: "ACME" },
			{ ts: 1700000000001n, amount: "-0.0000000001", symbol: "ACME" },
			{ ts: 1700000000002n, amount: "1234567890.0123456789", symbol: "ACME" },
			{ ts: 1700000000003n, amount: null, symbol: "ACME" },
		]);

		const rows = await conn.query<{ amount: string | null }>(
			"SELECT amount FROM prices WHERE symbol = 'ACME' ORDER BY ts",
		);
		expect(rows.map((r) => r.amount)).toEqual([
			"61.9900000000",
			"-0.0000000001",
			"1234567890.0123456789",
			null,
		]);
	});

	it("round-trips a DECIMAL64 (precision ≤ 18) through the columnar path", async () => {
		const repo = new SuperTableRepository(Rate, conn);
		await repo.ingestMany([
			{ ts: 1700000003000n, rate: "12.3456", pair: "EURCHF" },
			{ ts: 1700000003001n, rate: "-1", pair: "EURCHF" },
		]);

		const rows = await conn.query<{ rate: string }>(
			"SELECT rate FROM rates ORDER BY ts",
		);
		expect(rows.map((r) => r.rate)).toEqual(["12.3456", "-1.0000"]);
	});

	it("refuses a decimal with more fractional digits than the scale", async () => {
		const repo = new SuperTableRepository(Rate, conn);

		await expect(
			repo.ingestMany([{ ts: 1700000004000n, rate: "1.00001", pair: "X" }]),
		).rejects.toThrow(
			expect.objectContaining({
				code: "E_EON_BIND",
				message: expect.stringMatching(/fractional/s),
			}),
		);
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

	it("keeps the columnar path for a super-table without a decimal", async () => {
		const repo = new SuperTableRepository(Meter, conn);

		const result = await repo.ingestMany([
			{ ts: 1700000002000n, current: 10.5, location: "SF" },
		]);

		expect(result.rowsAffected).toBe(1);
	});
});
