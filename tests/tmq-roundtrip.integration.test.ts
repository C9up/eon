/**
 * The consumer against a REAL TDengine.
 *
 * The fake proves the seam's contract; only a live server proves the wiring —
 * that the TMQ config keys are the ones the driver expects, that `poll`'s
 * `TaosResult` decodes with the right column order, and that an offset actually
 * advances. Every one of those is a place a plausible-looking implementation
 * silently returns nothing.
 *
 * Gated on `EON_TEST_URL` like every other integration suite.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { EonConnection } from "../src/index.js";
import {
	createTestDatabase,
	dropTestDatabase,
	dropTestTopic,
} from "../src/testing/cleanup.js";
import { connectTestEon, hasTestServer } from "../src/testing/index.js";
import { describeIfTdengine } from "../src/testing/vitest.js";
import type { EonConsumer } from "../src/tmq/EonConsumer.js";
import { connectWsConsumer } from "../src/tmq/websocket.js";

const TEST_DB = "eon_tmq_test";
const TOPIC = "eon_tmq_topic";

describeIfTdengine("eon TMQ roundtrip (live TDengine)", () => {
	let conn: EonConnection;
	let consumer: EonConsumer | undefined;

	beforeAll(async () => {
		conn = await connectTestEon();
		// BEFORE the database: TDengine refuses to drop a database that still
		// carries a topic, so a crashed previous run would wedge every run after
		// it — and a failing beforeAll is reported as "skipped", which reads as
		// benign in the summary line.
		await dropTestTopic(conn, TOPIC);
		await createTestDatabase(conn, TEST_DB);
		await conn.exec(
			"CREATE STABLE meters (ts TIMESTAMP, current FLOAT) TAGS (groupid INT)",
		);
		await conn.exec(
			`CREATE TOPIC IF NOT EXISTS ${TOPIC} AS SELECT ts, current FROM meters`,
		);
	}, 60_000);

	afterAll(async () => {
		if (consumer) await consumer.close().catch(() => {});
		if (conn) {
			await conn.exec(`DROP TOPIC IF EXISTS ${TOPIC}`).catch(() => {});
			await dropTestDatabase(conn, TEST_DB).catch(() => {});
			await conn.close();
		}
	}, 30_000);

	it("subscribes, receives rows written after the subscription, and commits", async () => {
		consumer = await connectWsConsumer({
			url: process.env.EON_TEST_URL as string,
			groupId: "eon_test_group",
			clientId: "eon_test_client",
			user: "root",
			password: "taosdata",
			database: TEST_DB,
			// `earliest` so the test does not race the write against the
			// subscription taking effect.
			offsetReset: "earliest",
		});

		await consumer.subscribe([TOPIC]);
		expect(await consumer.subscription()).toContain(TOPIC);

		await conn.exec(
			"INSERT INTO d0 USING meters TAGS(1) VALUES (now, 10.5)(now+1s, 11.5)",
		);

		// Poll until the rows land or the budget runs out: TMQ delivery is not
		// synchronous with the insert, and a single poll would flake.
		const rows: Record<string, unknown>[] = [];
		const deadline = Date.now() + 20_000;
		while (rows.length < 2 && Date.now() < deadline) {
			for (const message of await consumer.poll(1_000)) {
				expect(message.topic).toBe(TOPIC);
				rows.push(...message.rows);
			}
		}

		expect(rows.length).toBeGreaterThanOrEqual(2);
		// Decoded by column NAME, not position — the thing a wrong meta/data zip
		// would get subtly wrong.
		const first = rows[0];
		expect(first).toBeDefined();
		expect(first).toHaveProperty("current");
		expect(typeof first?.current).toBe("number");

		const committed = await consumer.commit();
		expect(committed.some((p) => p.topic === TOPIC)).toBe(true);
	}, 60_000);

	it("reports its assignment for the subscribed topic", async () => {
		if (!hasTestServer() || !consumer) return;
		const assignment = await consumer.assignment([TOPIC]);
		expect(assignment.every((p) => p.topic === TOPIC)).toBe(true);
	}, 30_000);
});
