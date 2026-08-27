/**
 * Live connect → exec → query → close roundtrip against a real TDengine server
 * (AC6). Gated on `EON_TEST_URL` via `describeIfTdengine`: skips in local dev
 * without a server, RUNS in CI where the docker server + `EON_TEST_URL` are
 * present. Named `*.integration.test.ts` so the NAPI unit matrix excludes it
 * (its zero-skipped smoke gate) while the CI integration job runs it for real.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import type { EonConnection } from "../src/index.js";
import { compileStatementNative } from "../src/index.js";
import { connectTestEon, resetDatabase } from "../src/testing/index.js";
import { describeIfTdengine } from "../src/testing/vitest.js";

const TEST_DB = "eon_conn_roundtrip";

describeIfTdengine("EonConnection ws roundtrip (live TDengine)", () => {
	let conn: EonConnection;

	// Generous timeouts: the ws handshake + DDL against a cold docker server can
	// take well past vitest's 10s default (especially in CI).
	beforeAll(async () => {
		conn = await connectTestEon();
		await resetDatabase(conn, TEST_DB);
		await conn.exec(`USE ${TEST_DB}`);
		await conn.exec(
			"CREATE STABLE meters (ts TIMESTAMP, current FLOAT, voltage INT) TAGS (groupid INT)",
		);
	}, 60_000);

	afterAll(async () => {
		if (conn) {
			await conn.exec(`DROP DATABASE IF EXISTS ${TEST_DB}`);
			await conn.close();
		}
	}, 30_000);

	it("inserts via child-table auto-create and reads back a BigInt ts + values", async () => {
		// `USING meters TAGS(1)` auto-creates child table `d0` (spike-proven).
		const inserted = await conn.exec(
			"INSERT INTO d0 USING meters TAGS(1) VALUES (now, 10.3, 219)",
		);
		expect(inserted.rowsAffected).toBe(1);

		const rows = await conn.query("SELECT ts, current, voltage FROM meters");
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row).toBeDefined();
		if (!row) return;
		// The locked BigInt-timestamp contract (D4): TIMESTAMP comes back as BigInt.
		expect(typeof row.ts).toBe("bigint");
		expect(Number(row.current)).toBeCloseTo(10.3, 1);
		expect(row.voltage).toBe(219);
	});

	it("runs a compiler-produced param-free SELECT through the live connection", async () => {
		// Compiler ↔ transport proof: a param-free compiled SELECT is literal SQL,
		// so it runs via query() with no STMT binding (D3).
		const compiled = compileStatementNative(
			{
				kind: "select",
				table: "meters",
				select: ["ts", "current"],
				wheres: [],
				limit: 10,
			},
			"tdengine",
		);
		expect(compiled.params).toEqual([]);

		const sql = compiled.statements[0];
		expect(sql).toBeDefined();
		if (!sql) return;
		const rows = await conn.query(sql);
		expect(rows.length).toBeGreaterThanOrEqual(1);
		const first = rows[0];
		expect(first).toBeDefined();
		if (!first) return;
		expect(typeof first.ts).toBe("bigint");
	});
});
