import { describe, expect, it } from "vitest";
import { ensureDatabase } from "../src/connection/ensureDatabase.js";
import type { EonConnection, EonConnectionConfig } from "../src/index.js";
import { FakeEonConnection } from "../src/testing/FakeEonConnection.js";

/**
 * A connector that records the config of every connection it is asked to open,
 * and hands back one `FakeEonConnection` recording every statement.
 */
function makeConnector(): {
	connect: (config: EonConnectionConfig) => Promise<EonConnection>;
	opened: EonConnectionConfig[];
	statements: string[];
	closes: () => number;
} {
	const opened: EonConnectionConfig[] = [];
	const fake = new FakeEonConnection();
	let closes = 0;
	const conn: EonConnection = {
		...fake,
		transport: "fake",
		exec: (sql) => fake.exec(sql),
		query: (sql) => fake.query(sql),
		ping: () => fake.ping(),
		ingestColumnar: (ingest) => fake.ingestColumnar(ingest),
		schemaless: (lines, options) => fake.schemaless(lines, options),
		close: () => {
			closes += 1;
			return Promise.resolve();
		},
	};
	return {
		connect: (config) => {
			opened.push(config);
			return Promise.resolve(conn);
		},
		opened,
		statements: fake.statements,
		closes: () => closes,
	};
}

describe("ensureDatabase", () => {
	it("does nothing when `createDatabase` is unset — atlas's behaviour", async () => {
		const c = makeConnector();
		await ensureDatabase({ url: "ws://h:6041", database: "qwalto" }, c.connect);
		expect(c.opened).toHaveLength(0);
		expect(c.statements).toHaveLength(0);
	});

	it("does nothing when `createDatabase` is explicitly false", async () => {
		const c = makeConnector();
		await ensureDatabase(
			{ url: "ws://h:6041", database: "qwalto", createDatabase: false },
			c.connect,
		);
		expect(c.opened).toHaveLength(0);
	});

	it("creates the database on a connection that selects none", async () => {
		// Selecting the database is precisely what fails while it is missing, so
		// the bootstrap connection must not carry it.
		const c = makeConnector();
		await ensureDatabase(
			{ url: "ws://h:6041", database: "qwalto", createDatabase: true },
			c.connect,
		);
		expect(c.opened).toHaveLength(1);
		expect(c.opened[0]?.database).toBeUndefined();
		expect(c.opened[0]?.createDatabase).toBeUndefined();
		expect(c.statements).toEqual(["CREATE DATABASE IF NOT EXISTS `qwalto`"]);
	});

	it("carries auth and connect-retry settings onto the bootstrap connection", async () => {
		// A cold docker server is exactly when the database is missing, so the
		// retry knob has to survive onto the connection that creates it.
		const c = makeConnector();
		await ensureDatabase(
			{
				url: "ws://h:6041",
				database: "qwalto",
				user: "root",
				password: "taosdata",
				connectRetries: 10,
				connectBackoffMs: 250,
				createDatabase: true,
			},
			c.connect,
		);
		expect(c.opened[0]).toMatchObject({
			url: "ws://h:6041",
			user: "root",
			password: "taosdata",
			connectRetries: 10,
			connectBackoffMs: 250,
		});
	});

	it("renders the retention and precision options it was given", async () => {
		// PRECISION is create-only in TDengine — getting it right here is the
		// whole reason the application creates the database itself.
		const c = makeConnector();
		await ensureDatabase(
			{
				url: "ws://h:6041",
				database: "metrics",
				createDatabase: { keep: "90d", duration: "10d", precision: "ms" },
			},
			c.connect,
		);
		expect(c.statements[0]).toBe(
			"CREATE DATABASE IF NOT EXISTS `metrics` KEEP 90d DURATION 10d PRECISION 'ms'",
		);
	});

	it("closes the bootstrap connection", async () => {
		const c = makeConnector();
		await ensureDatabase(
			{ url: "ws://h:6041", database: "qwalto", createDatabase: true },
			c.connect,
		);
		expect(c.closes()).toBe(1);
	});

	it("closes the bootstrap connection even when the statement fails", async () => {
		let closed = 0;
		const conn: EonConnection = {
			transport: "fake",
			exec: () => Promise.reject(new Error("server said no")),
			query: () => Promise.resolve([]),
			ping: () => Promise.resolve(),
			ingestColumnar: () => Promise.resolve({ rowsAffected: 0 }),
			schemaless: () => Promise.resolve(),
			close: () => {
				closed += 1;
				return Promise.resolve();
			},
		};
		await expect(
			ensureDatabase(
				{ url: "ws://h:6041", database: "qwalto", createDatabase: true },
				() => Promise.resolve(conn),
			),
		).rejects.toThrow("server said no");
		expect(closed).toBe(1);
	});

	it("refuses `createDatabase` with no database to create", async () => {
		const c = makeConnector();
		await expect(
			ensureDatabase({ url: "ws://h:6041", createDatabase: true }, c.connect),
		).rejects.toThrow(/no `database` is configured/);
		expect(c.opened).toHaveLength(0);
	});

	it("rejects a database name the compiler cannot quote", async () => {
		// The Rust compiler quotes and validates the identifier — no interpolation
		// seam is opened by taking the name from config.
		const c = makeConnector();
		await expect(
			ensureDatabase(
				{ url: "ws://h:6041", database: "a`b", createDatabase: true },
				c.connect,
			),
		).rejects.toThrow();
		expect(c.opened).toHaveLength(0);
	});
});
