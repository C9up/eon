/**
 * Live check of the bug-019 migration: children written under the former FNV-1a
 * names move onto the digest names with their rows and tags, and the ingest
 * path then writes into the moved child instead of opening a second one.
 * Gated on `EON_TEST_URL` (runs in CI's docker job).
 */

import "reflect-metadata";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { EonConnection } from "../src/index.js";
import {
	Column,
	childTableName,
	createChildTable,
	legacyChildTableName,
	migrateChildTableNames,
	SuperTable,
	SuperTableRepository,
	syncSuperTable,
	Tag,
	Timestamp,
} from "../src/index.js";
import { connectTestEon, resetDatabase } from "../src/testing/index.js";
import { describeIfTdengine } from "../src/testing/vitest.js";

const TEST_DB = "eon_child_name_migration";

@SuperTable("meters")
class Meter {
	@Timestamp() declare ts: bigint;
	@Column({ type: "double" }) declare current: number;
	@Tag({ type: "int" }) declare groupid: number;
	@Tag({ type: "nchar", length: 24 }) declare location: string;
}

describeIfTdengine("child-name migration (live TDengine, bug 019)", () => {
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

	async function children(): Promise<string[]> {
		const rows = await conn.query<{ name: string }>(
			"SELECT DISTINCT TBNAME AS name FROM meters",
		);
		return rows.map((r) => r.name).sort();
	}

	async function count(table: string): Promise<number> {
		const rows = await conn.query<{ n: bigint | number }>(
			`SELECT COUNT(*) AS n FROM ${table}`,
		);
		return Number(rows[0]?.n ?? 0);
	}

	it("moves legacy children with their rows, then ingest reuses them", async () => {
		const legacy = legacyChildTableName("meters", [1, "SF"]);
		const next = childTableName("meters", [1, "SF"]);
		await createChildTable(conn, {
			stable: "meters",
			name: legacy,
			tags: [1, "SF"],
		});
		await createChildTable(conn, {
			stable: "meters",
			name: "explicit_child",
			tags: [2, "LA"],
		});
		await conn.exec(
			`INSERT INTO ${legacy} VALUES (1700000000000, 1.5) (1700000000001, 2.5)`,
		);

		const dry = await migrateChildTableNames(conn, Meter, { dryRun: true });
		expect(dry.renamed).toEqual([{ from: legacy, to: next, tags: [1, "SF"] }]);
		expect(await children()).toEqual(["explicit_child", legacy].sort());

		const report = await migrateChildTableNames(conn, Meter);
		expect(report.renamed).toEqual([
			{ from: legacy, to: next, tags: [1, "SF"] },
		]);
		expect(report.unmatched).toEqual(["explicit_child"]);
		expect(await children()).toEqual(["explicit_child", next].sort());
		expect(await count(next)).toBe(2);

		const again = await migrateChildTableNames(conn, Meter);
		expect(again.renamed).toEqual([]);
		expect(again.current).toEqual([next]);

		await new SuperTableRepository(Meter, conn).ingestSql([
			{ ts: 1700000000002n, current: 3.5, groupid: 1, location: "SF" },
		]);
		expect(await children()).toEqual(["explicit_child", next].sort());
		expect(await count(next)).toBe(3);
	});
});
