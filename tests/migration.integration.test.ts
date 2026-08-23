/**
 * Docker-gated end-to-end: migrate then rollback against a real TDengine.
 * Skips unless `EON_TEST_URL` is set (`describeIfTdengine`), mirroring the other
 * eon integration suites.
 */

import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { EonConnection } from "../src/index.js";
import { EonMigrationRunner } from "../src/index.js";
import {
	connectTestEon,
	describeIfTdengine,
	resetDatabase,
} from "../src/testing/index.js";

const migrationsDir = fileURLToPath(
	new URL("./fixtures/migrations", import.meta.url),
);

describeIfTdengine("EonMigrationRunner (integration)", () => {
	let conn: EonConnection | undefined;
	const db = "eon_mig_test";

	// Generous timeouts, like every other integration suite here: the ws
	// handshake plus DDL against a cold docker server runs well past vitest's
	// 10s default, and a hook that times out reports its tests as SKIPPED — a
	// green-looking run that verified nothing.
	beforeAll(async () => {
		conn = await connectTestEon();
		await resetDatabase(conn, db);
		await conn.exec(`USE ${db}`);
	}, 60_000);

	afterAll(async () => {
		await conn?.close();
	}, 30_000);

	it("migrates then rolls back, tracking each step", async () => {
		if (conn === undefined) throw new Error("no connection");
		const runner = new EonMigrationRunner(conn, { migrationsDir });

		const applied = await runner.migrate();
		expect(applied).toEqual(["0001_create_meters", "0002_add_voltage"]);
		expect((await runner.status()).every((s) => s.state === "applied")).toBe(
			true,
		);

		const rolled = await runner.rollback();
		expect(rolled).toEqual(["0002_add_voltage", "0001_create_meters"]);
		expect((await runner.status()).every((s) => s.state === "pending")).toBe(
			true,
		);
	});
});
