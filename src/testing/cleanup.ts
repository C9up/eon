/**
 * Test-database lifecycle for eon integration suites.
 *
 * Every integration file used to spell its own
 * `await conn.exec("DROP DATABASE IF EXISTS " + TEST_DB)` in `afterAll` —
 * seven copies of one rule, which is how a cleanup quietly stops matching its
 * setup. Atlas ships `truncateAll` / `useTransaction` for the same reason;
 * TDengine has no transactions, so the unit here is the database.
 */
import type { EonConnection } from "../connection/EonConnection.js";

/** TDengine identifiers: a letter or underscore, then letters, digits, underscores. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Guard an identifier before it is interpolated into DDL.
 *
 * `exec` takes literal SQL — TDengine binds no `?` in DDL — so a database name
 * reaching these helpers is concatenated. A test name is not attacker-supplied,
 * but a typo'd one silently becomes a different statement, and `DROP DATABASE`
 * is the statement you least want to be surprising.
 */
function assertIdentifier(name: string, what: string): void {
	if (!IDENTIFIER.test(name)) {
		throw new Error(
			`[E_EON_TEST_IDENTIFIER] invalid ${what} '${name}'; must match ${IDENTIFIER}`,
		);
	}
}

/**
 * Drop a subscription topic if it exists. Safe to call when it never existed.
 *
 * Order matters: TDengine REFUSES to drop a database that still carries a
 * topic ("Topic must be dropped first"), so a suite that creates one must drop
 * it before {@link dropTestDatabase} or {@link createTestDatabase} — including
 * on the setup path, where a topic left by a crashed previous run is exactly
 * what breaks the next one.
 */
export async function dropTestTopic(
	conn: EonConnection,
	topic: string,
	options: { retries?: number; delayMs?: number } = {},
): Promise<void> {
	assertIdentifier(topic, "topic name");
	const retries = options.retries ?? 10;
	const delayMs = options.delayMs ?? 300;

	// TDengine rebalances a topic's partitions for a moment after a consumer
	// disconnects, and refuses DROP TOPIC with "Topic being rebalanced" until it
	// settles. Any suite that subscribed hits this, so the wait belongs here
	// rather than copy-pasted into each one — and it must be BOUNDED: retrying
	// forever would turn a real failure into a hang.
	for (let attempt = 0; ; attempt++) {
		try {
			await conn.exec(`DROP TOPIC IF EXISTS ${topic}`);
			return;
		} catch (error) {
			const rebalancing = /being rebalanced/i.test(
				error instanceof Error ? error.message : String(error),
			);
			if (!rebalancing || attempt >= retries) throw error;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

/**
 * Drop a test database if it exists. Safe to call when it never existed.
 *
 * Fails if the database still carries a topic — see {@link dropTestTopic}.
 */
export async function dropTestDatabase(
	conn: EonConnection,
	database: string,
): Promise<void> {
	assertIdentifier(database, "database name");
	await conn.exec(`DROP DATABASE IF EXISTS ${database}`);
}

/**
 * Drop, recreate and `USE` a test database — the setup half of a suite.
 *
 * Dropping FIRST is the point: a suite that crashed mid-run leaves rows behind,
 * and a `CREATE DATABASE IF NOT EXISTS` would then run against them. A test
 * that passes only because the previous run left the right data is worse than
 * one that fails.
 */
export async function createTestDatabase(
	conn: EonConnection,
	database: string,
	options: { keepMs?: number } = {},
): Promise<void> {
	assertIdentifier(database, "database name");
	await conn.exec(`DROP DATABASE IF EXISTS ${database}`);
	const keep = options.keepMs === undefined ? "" : ` KEEP ${options.keepMs}`;
	await conn.exec(`CREATE DATABASE ${database}${keep}`);
	await conn.exec(`USE ${database}`);
}

/**
 * Run a body against a freshly created test database, dropping it afterwards
 * whether the body threw or not.
 *
 * The `finally` is what the hand-written `afterAll` blocks kept getting right
 * by accident: a failing assertion must still leave the server clean, or the
 * next run inherits the wreckage of this one.
 */
export async function withTestDatabase<T>(
	conn: EonConnection,
	database: string,
	body: () => Promise<T>,
): Promise<T> {
	await createTestDatabase(conn, database);
	try {
		return await body();
	} finally {
		await dropTestDatabase(conn, database);
	}
}
