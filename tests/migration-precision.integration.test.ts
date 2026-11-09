/**
 * The tracking table's `executed_at` is a TIMESTAMP, and TDengine reads an
 * integer timestamp in the DATABASE's precision. A millisecond clock written
 * into a 'us' or 'ns' database lands in 1970, outside the KEEP window, and the
 * insert is refused after the migration's DDL already ran.
 */

import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { EonConnection } from "../src/index.js";
import { EonMigrationRunner } from "../src/index.js";
import { connectTestEon } from "../src/testing/index.js";
import { describeIfTdengine } from "../src/testing/vitest.js";

const migrationsDir = fileURLToPath(
	new URL("./fixtures/migrations", import.meta.url),
);

const PRECISIONS = ["ms", "us", "ns"] as const;

describeIfTdengine("EonMigrationRunner in every precision (live)", () => {
	let conn: EonConnection | undefined;

	beforeAll(async () => {
		conn = await connectTestEon();
	}, 60_000);

	afterAll(async () => {
		for (const precision of PRECISIONS) {
			await conn?.exec(`DROP DATABASE IF EXISTS eon_mig_prec_${precision}`);
		}
		await conn?.close();
	}, 30_000);

	it.each(PRECISIONS)(
		"migrates, reports and rolls back in a '%s' database",
		async (precision) => {
			if (conn === undefined) throw new Error("no connection");
			const db = `eon_mig_prec_${precision}`;
			await conn.exec(`DROP DATABASE IF EXISTS ${db}`);
			await conn.exec(`CREATE DATABASE ${db} PRECISION '${precision}'`);
			await conn.exec(`USE ${db}`);
			const runner = new EonMigrationRunner(conn, { migrationsDir });

			expect(await runner.migrate()).toEqual([
				"0001_create_meters",
				"0002_add_voltage",
			]);
			expect((await runner.status()).map((s) => s.status)).toEqual([
				"applied",
				"applied",
			]);
			expect(await runner.migrate()).toEqual([]);

			expect(await runner.rollback()).toEqual([
				"0002_add_voltage",
				"0001_create_meters",
			]);
			expect((await runner.status()).map((s) => s.status)).toEqual([
				"pending",
				"pending",
			]);
		},
		60_000,
	);
});
