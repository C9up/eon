/**
 * The three write paths of a repository work on one schema: a super-table
 * created from the entity takes schemaless points, and what schemaless writes
 * reads back through `query()` and accepts STMT rows after it.
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

const TEST_DB = "eon_schemaless_schema";

@SuperTable("readings")
class Reading {
	@Timestamp() declare _ts: bigint;
	@Column({ type: "tinyInt" }) declare a: number;
	@Column({ type: "smallInt" }) declare b: number;
	@Column({ type: "int" }) declare n: number;
	@Column({ type: "bigInt" }) declare big: bigint;
	@Column({ type: "float" }) declare f: number;
	@Column({ type: "double" }) declare d: number;
	@Column({ type: "varchar", length: 16 }) declare v: string;
	@Column({ type: "nchar", length: 16 }) declare w: string;
	@Tag({ type: "nchar", length: 16 }) declare site: string;
}

@SuperTable("fresh")
class Fresh {
	@Timestamp() declare _ts: bigint;
	@Column({ type: "int" }) declare n: number;
	@Tag({ type: "nchar", length: 16 }) declare site: string;
}

const point = {
	a: 1,
	b: 2,
	n: 3,
	big: 4n,
	f: 1.5,
	d: 2.5,
	v: "plain",
	w: "wörld",
	site: "a",
};

describeIfTdengine("schemaless writes the entity's schema (live)", () => {
	let conn: EonConnection;

	beforeAll(async () => {
		conn = await connectTestEon();
		await resetDatabase(conn, TEST_DB);
		await conn.exec(`USE ${TEST_DB}`);
	}, 60_000);

	afterAll(async () => {
		if (conn) {
			await conn.exec(`DROP DATABASE IF EXISTS ${TEST_DB}`);
			await conn.close();
		}
	}, 30_000);

	it("writes into a super-table synced from the entity, readable by query()", async () => {
		await syncSuperTable(conn, Reading);
		const repo = new SuperTableRepository(Reading, conn);
		await repo.ingestSchemaless([{ _ts: 1700000000000n, ...point }]);
		await repo.ingestMany([{ _ts: 1700000001000n, ...point, site: "b" }]);
		const rows = await repo.query().orderBy("_ts");
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row).toMatchObject({
				a: 1,
				b: 2,
				n: 3,
				big: 4n,
				f: 1.5,
				d: 2.5,
				v: "plain",
				w: "wörld",
			});
		}
	}, 30_000);

	it("creates a super-table that query() and ingestMany() then use", async () => {
		const repo = new SuperTableRepository(Fresh, conn);
		await repo.ingestSchemaless([{ _ts: 1700000000000n, n: 7, site: "a" }]);
		await repo.ingestMany([{ _ts: 1700000001000n, n: 8, site: "a" }]);
		const rows = await repo.query().orderBy("_ts");
		expect(rows.map((r) => r.n)).toEqual([7, 8]);
	}, 30_000);
});
