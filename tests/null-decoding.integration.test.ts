/**
 * A SQL NULL comes back as `null`, not as the string "NULL".
 *
 * `@tdengine/websocket` 3.5.0 pushes the four characters "NULL" for an empty
 * cell whatever the column type (`taosResult.js:186` and `:200`). The type is
 * therefore correct when the value is present and wrong when it is absent — a
 * BIGINT reads as `bigint` on every row until the first null one, where it
 * turns into `string`, which is how a `typeof` check written against the happy
 * path survives for months and then does not.
 *
 * eon converts it back for every type that cannot hold the string. Text and
 * binary columns are left alone on purpose, and this pins that too: there the
 * bitmap that knew the difference is already gone, and converting would
 * corrupt a real value to repair an absent one.
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

const TEST_DB = "eon_null_decoding";

/** A nullable BIGINT beside the timestamp — the shape that made the ORM throw. */
@SuperTable("payouts")
class Payout {
	@Timestamp() declare ts: bigint;
	@Column({ type: "bigint" }) declare recordDate: bigint | null;
	@Tag({ type: "nchar", length: 16 }) declare symbol: string;
}

describeIfTdengine("eon null decoding (live TDengine)", () => {
	let conn: EonConnection;

	beforeAll(async () => {
		conn = await connectTestEon();
		await resetDatabase(conn, TEST_DB);
		await conn.exec(`USE ${TEST_DB}`);
		await conn.exec(
			"CREATE TABLE nullable (ts TIMESTAMP, d DECIMAL(28,10), t2 TIMESTAMP, bi BIGINT, f DOUBLE, b BOOL, v VARCHAR(16))",
		);
		await conn.exec(
			"INSERT INTO nullable VALUES (1704153600000, NULL, NULL, NULL, NULL, NULL, NULL)",
		);
		await conn.exec(
			"INSERT INTO nullable VALUES (1704240000000, 1.5, 1704240000000, 42, 2.5, true, 'x')",
		);
		await syncSuperTable(conn, Payout);
		await new SuperTableRepository(Payout, conn).ingestSql([
			{ ts: 1704153600000n, recordDate: null, symbol: "ACME" },
			{ ts: 1704240000000n, recordDate: 1704240000000n, symbol: "ACME" },
		]);
	}, 60_000);

	afterAll(async () => {
		if (conn) {
			await conn.exec(`DROP DATABASE IF EXISTS ${TEST_DB}`);
			await conn.close();
		}
	}, 30_000);

	it("gives null for every type that cannot hold the string", async () => {
		const rows = await conn.query<Record<string, unknown>>(
			"SELECT * FROM nullable WHERE ts = 1704153600000",
		);
		const empty = rows[0];

		expect(empty).toBeDefined();
		expect(empty?.d).toBeNull();
		expect(empty?.t2).toBeNull();
		expect(empty?.bi).toBeNull();
		expect(empty?.f).toBeNull();
		expect(empty?.b).toBeNull();
	});

	it("leaves the present values exactly as they were", async () => {
		const rows = await conn.query<Record<string, unknown>>(
			"SELECT * FROM nullable WHERE ts = 1704240000000",
		);
		const filled = rows[0];

		expect(typeof filled?.t2).toBe("bigint");
		expect(typeof filled?.bi).toBe("bigint");
		expect(filled?.f).toBe(2.5);
		expect(filled?.v).toBe("x");
		expect(filled?.d).toBe("1.5000000000");
	});

	it("keeps the type stable across a null row and a filled one", async () => {
		// The whole point: a column must not change JavaScript type depending on
		// whether the cell happens to be empty.
		const rows = await conn.query<Record<string, unknown>>(
			"SELECT bi FROM nullable ORDER BY ts",
		);

		expect(rows.map((r) => (r.bi === null ? "null" : typeof r.bi))).toEqual([
			"null",
			"bigint",
		]);
	});

	it("does NOT touch a text column, where the string is a legitimate value", async () => {
		// Named, not silently half-fixed: only the connector can tell an empty
		// VARCHAR from one holding the four characters NULL.
		const rows = await conn.query<Record<string, unknown>>(
			"SELECT v FROM nullable WHERE ts = 1704153600000",
		);

		expect(rows[0]?.v).toBe("NULL");
	});

	it("reads a super-table with a nullable bigint instead of throwing", async () => {
		// This is what the string "NULL" cost: reviveBigInt could not revive it,
		// so a single null cell made the whole super-table unreadable through
		// the ORM — the failure landed before the caller's mapper ever ran.
		const rows = await new SuperTableRepository(Payout, conn).query().all();

		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.recordDate)).toEqual([null, 1704240000000n]);
	});
});
