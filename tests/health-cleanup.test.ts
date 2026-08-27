/**
 * The health check and the test-database lifecycle.
 *
 * Both are things an operator or a suite leans on without watching: a check
 * that reports `ok` for an unreachable server, or a cleanup that skips when the
 * body throws, fails silently and stays failing.
 */
import { describe, expect, it } from "vitest";
import type { EonConnection } from "../src/connection/EonConnection.js";
import { EonConnectionCheck } from "../src/health.js";
import {
	createTestDatabase,
	dropTestDatabase,
	dropTestTopic,
	withTestDatabase,
} from "../src/testing/cleanup.js";

/** A connection that records its statements and can be made slow or broken. */
function fakeConnection(
	behaviour: { pingDelayMs?: number; pingThrows?: Error } = {},
): EonConnection & { statements: string[] } {
	const statements: string[] = [];
	const conn = {
		statements,
		async exec(sql: string) {
			statements.push(sql);
			return { rowsAffected: 0 };
		},
		async query() {
			return [];
		},
		async ping() {
			if (behaviour.pingThrows) throw behaviour.pingThrows;
			if (behaviour.pingDelayMs) {
				await new Promise((r) => setTimeout(r, behaviour.pingDelayMs));
			}
		},
		async ingestColumnar() {
			return { rowsAffected: 0 };
		},
		async schemaless() {
			return { rowsAffected: 0 };
		},
		async close() {},
	};
	return conn as unknown as EonConnection & { statements: string[] };
}

describe("EonConnectionCheck", () => {
	it("reports ok with the latency it measured", async () => {
		const result = await new EonConnectionCheck(fakeConnection()).run();
		expect(result.status).toBe("ok");
		expect(result.meta?.latency).toBeTypeOf("number");
	});

	it("warns on a reachable-but-slow server instead of failing it", async () => {
		// Failing would pull a healthy pod out of rotation; ok would hide the
		// thing an operator needs to see.
		const check = new EonConnectionCheck(
			fakeConnection({ pingDelayMs: 40 }),
		).warnWhenSlowerThan(10);

		const result = await check.run();
		expect(result.status).toBe("warning");
		expect(result.message).toMatch(/above the threshold of 10ms/);
	});

	it("fails when the server does not answer, keeping the error not just its message", async () => {
		const boom = new Error("ECONNREFUSED");
		const result = await new EonConnectionCheck(
			fakeConnection({ pingThrows: boom }),
		).run();

		expect(result.status).toBe("error");
		expect(result.meta?.error).toBe(boom);
	});

	it("satisfies ream's contract structurally, without importing the framework", async () => {
		const source = await import("node:fs/promises").then((fs) =>
			fs.readFile(new URL("../src/health.ts", import.meta.url), "utf8"),
		);
		expect(source).not.toMatch(/from ["']@c9up\/ream/);

		const check = new EonConnectionCheck(fakeConnection())
			.as("primary")
			.cacheFor(30);
		expect(check.name).toBe("primary");
		expect(check.cacheDuration).toBe(30);
		expect(typeof check.run).toBe("function");
	});
});

describe("test-database lifecycle", () => {
	it("drops BEFORE creating, so a crashed run leaves nothing behind", async () => {
		const conn = fakeConnection();
		await createTestDatabase(conn, "eon_probe");

		expect(conn.statements).toEqual([
			"DROP DATABASE IF EXISTS eon_probe",
			"CREATE DATABASE eon_probe",
			"USE eon_probe",
		]);
	});

	it("drops the database even when the body throws", async () => {
		const conn = fakeConnection();
		await expect(
			withTestDatabase(conn, "eon_probe", async () => {
				throw new Error("assertion failed");
			}),
		).rejects.toThrow("assertion failed");

		// The whole point of the finally: a failing test must still leave the
		// server clean, or the next run inherits this one's wreckage.
		expect(conn.statements.at(-1)).toBe("DROP DATABASE IF EXISTS eon_probe");
	});

	it("returns the body's value when it does not throw", async () => {
		const conn = fakeConnection();
		await expect(
			withTestDatabase(conn, "eon_probe", async () => 42),
		).resolves.toBe(42);
	});

	it("refuses a name that is not a plain identifier", async () => {
		const conn = fakeConnection();
		// `exec` takes literal SQL, so the name is concatenated. DROP DATABASE is
		// the statement you least want to be surprising.
		await expect(
			dropTestDatabase(conn, "probe; DROP DATABASE prod"),
		).rejects.toThrow(/invalid database name/);
		await expect(createTestDatabase(conn, "1bad")).rejects.toThrow(
			/invalid database name/,
		);
		expect(conn.statements).toEqual([]);
	});
});

describe("dropTestTopic", () => {
	/** A connection whose exec fails N times with the server's rebalance error. */
	function rebalancingConnection(failures: number) {
		let seen = 0;
		const statements: string[] = [];
		return {
			statements,
			get attempts() {
				return seen;
			},
			async exec(sql: string) {
				seen++;
				if (seen <= failures) throw new Error("Topic being rebalanced");
				statements.push(sql);
				return { rowsAffected: 0 };
			},
		} as unknown as EonConnection & { statements: string[]; attempts: number };
	}

	it("waits out a rebalance instead of failing the suite", async () => {
		// TDengine refuses DROP TOPIC for a moment after a consumer disconnects.
		// Every suite that subscribed hits it, which is why the wait lives here.
		const conn = rebalancingConnection(3);
		await dropTestTopic(conn, "eon_probe_topic", { delayMs: 1 });
		expect(conn.statements).toEqual(["DROP TOPIC IF EXISTS eon_probe_topic"]);
	});

	it("gives up after the bound rather than hanging", async () => {
		// Retrying forever would turn a real failure into a hang — the worse of
		// the two outcomes, because nothing reports it.
		const conn = rebalancingConnection(99);
		await expect(
			dropTestTopic(conn, "eon_probe_topic", { retries: 2, delayMs: 1 }),
		).rejects.toThrow(/being rebalanced/);
	});

	it("does not retry an unrelated error", async () => {
		const conn = {
			async exec() {
				throw new Error("Permission denied");
			},
		} as unknown as EonConnection;
		await expect(
			dropTestTopic(conn, "eon_probe_topic", { delayMs: 1 }),
		).rejects.toThrow(/Permission denied/);
	});

	it("refuses a topic name that is not a plain identifier", async () => {
		const conn = rebalancingConnection(0);
		await expect(dropTestTopic(conn, "t; DROP DATABASE prod")).rejects.toThrow(
			/invalid topic name/,
		);
	});
});
