/**
 * Test helpers for @c9up/eon — the REAL-connection harness for integration
 * suites (58.2) PLUS the in-memory fake store + factory (58.6).
 *
 * `EON_TEST_URL` gates the live paths: unset → local dev without a server, so
 * integration suites skip via `describeIfTdengine` (mirrors atlas's "no external
 * DB required for unit tests" posture). CI sets it, so the roundtrip runs for
 * real — no silent cap. The fake store + factory need NO server.
 *
 * This module is RUNNER-AGNOSTIC and must stay that way: it is a shipped export
 * path, so anything it imports becomes a hard requirement for every consumer.
 * `describeIfTdengine` lives in `./vitest.js` for that reason.
 */

import type { EonConnectionConfig } from "../connection/config.js";
import type { EonConnection } from "../connection/EonConnection.js";
import { connectWsEon } from "../connection/websocket.js";

export {
	createTestDatabase,
	dropTestDatabase,
	dropTestTopic,
	withTestDatabase,
} from "./cleanup.js";
export { type FactoryBuilder, factory } from "./Factory.js";
export { FakeEonConnection } from "./FakeEonConnection.js";
export { FakeEonConsumer } from "./FakeEonConsumer.js";

/** The live TDengine URL for integration tests (taosAdapter WS), or `undefined`. */
function testUrl(): string | undefined {
	const url = process.env.EON_TEST_URL;
	return typeof url === "string" && url.length > 0 ? url : undefined;
}

/** Whether an `EON_TEST_URL` is configured (a live TDengine is reachable). */
export function hasTestServer(): boolean {
	return testUrl() !== undefined;
}

/**
 * Open a connection to the test server (`EON_TEST_URL`), applying root/taosdata
 * defaults and a generous connect-retry for a cold docker server. Callers gate
 * with `hasTestServer()` / `describeIfTdengine` first.
 */
export function connectTestEon(
	overrides: Partial<EonConnectionConfig> = {},
): Promise<EonConnection> {
	const url = testUrl();
	if (!url) {
		throw new Error(
			"[eon] connectTestEon requires EON_TEST_URL (a live TDengine taosAdapter WS URL, e.g. ws://localhost:6041).",
		);
	}
	return connectWsEon({
		url,
		user: "root",
		password: "taosdata",
		connectRetries: 10,
		connectBackoffMs: 250,
		...overrides,
	});
}

/**
 * Reset a database for test isolation: drop it if present, then recreate it at
 * millisecond precision. The name is validated against a safe alphabet before
 * interpolation — a test-only helper, but no injection footgun.
 */
export async function resetDatabase(
	conn: EonConnection,
	db: string,
): Promise<void> {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(db)) {
		throw new Error(`[eon] resetDatabase: unsafe database name '${db}'`);
	}
	await conn.exec(`DROP DATABASE IF EXISTS ${db}`);
	await conn.exec(`CREATE DATABASE ${db} PRECISION 'ms'`);
}
