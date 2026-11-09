/**
 * The STMT path must write each value into the column it is named after, not
 * into whatever column sits at the same position in the STABLE. A stable built
 * by a migration (or widened by `alterStable(addColumn)`) does not have to list
 * its columns in the entity's declaration order, and two DOUBLE columns swapped
 * by position are accepted by the server without a word.
 */

import "reflect-metadata";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { EonConnection } from "../src/index.js";
import {
	Column,
	EonSchema,
	SuperTable,
	SuperTableRepository,
	Tag,
	Timestamp,
} from "../src/index.js";
import { connectTestEon, resetDatabase } from "../src/testing/index.js";
import { describeIfTdengine } from "../src/testing/vitest.js";

const TEST_DB = "eon_stmt_column_order";

@SuperTable("swapped")
class Swapped {
	@Timestamp() declare ts: bigint;
	@Column({ type: "double" }) declare current: number;
	@Column({ type: "double" }) declare voltage: number;
	@Tag({ type: "varchar", length: 16 }) declare site: string;
}

@SuperTable("widened")
class Widened {
	@Timestamp() declare ts: bigint;
	@Column({ type: "double" }) declare current: number;
	@Column({ type: "double" }) declare phase: number;
	@Column({ type: "double" }) declare voltage: number;
	@Tag({ type: "varchar", length: 16 }) declare site: string;
}

describeIfTdengine("STMT ingest binds by column name (live TDengine)", () => {
	let conn: EonConnection;

	beforeAll(async () => {
		conn = await connectTestEon();
		await resetDatabase(conn, TEST_DB);
		await conn.exec(`USE ${TEST_DB}`);
		const schema = new EonSchema()
			.createStable("swapped", (t) => {
				t.timestamp("ts");
				t.double("voltage");
				t.double("current");
				t.varchar("site", 16).tag();
			})
			.createStable("widened", (t) => {
				t.timestamp("ts");
				t.double("current");
				t.double("voltage");
				t.varchar("site", 16).tag();
			})
			.alterStable("widened", (t) => {
				t.addColumn("phase").double();
			});
		for (const sql of schema.toSQL()) await conn.exec(sql);
	}, 60_000);

	afterAll(async () => {
		if (conn) {
			await conn.exec(`DROP DATABASE IF EXISTS ${TEST_DB}`);
			await conn.close();
		}
	}, 30_000);

	it("writes into the named columns when the stable orders them differently", async () => {
		const repo = new SuperTableRepository(Swapped, conn);
		await repo.ingestMany([
			{ ts: 1700000000000n, current: 1.5, voltage: 230, site: "a" },
		]);
		const rows = await conn.query<{ current: number; voltage: number }>(
			"SELECT `current`, `voltage` FROM `swapped`",
		);
		expect(rows).toEqual([{ current: 1.5, voltage: 230 }]);
	}, 30_000);

	it("writes into the named columns after a column was appended by ALTER", async () => {
		const repo = new SuperTableRepository(Widened, conn);
		await repo.ingestMany([
			{ ts: 1700000000000n, current: 1.5, phase: 3, voltage: 230, site: "a" },
		]);
		const rows = await conn.query<{
			current: number;
			phase: number;
			voltage: number;
		}>("SELECT `current`, `phase`, `voltage` FROM `widened`");
		expect(rows).toEqual([{ current: 1.5, phase: 3, voltage: 230 }]);
	}, 30_000);
});
