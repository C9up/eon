/**
 * eon's errors name the statement but never its values (`sqlHead`). The server
 * echoes data in its own messages — the SQL fragment of a syntax error, the
 * whole point of a refused schemaless line — so that text must stay on
 * `.cause` and out of `.message`, which is what reaches log sinks.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import type { EonConnection } from "../src/index.js";
import { EonConnectionError } from "../src/index.js";
import { connectTestEon, resetDatabase } from "../src/testing/index.js";
import { describeIfTdengine } from "../src/testing/vitest.js";

const TEST_DB = "eon_error_redaction";
const SECRET = "S3cretSite";
const SECRET_NUMBER = "424242";

async function failure(
	run: () => Promise<unknown>,
): Promise<EonConnectionError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof EonConnectionError) return error;
		throw error;
	}
	throw new Error("expected a failure");
}

function causeMessage(error: EonConnectionError): string {
	return error.cause instanceof Error
		? error.cause.message
		: String(error.cause);
}

describeIfTdengine(
	"server messages do not leak values into eon errors (live)",
	() => {
		let conn: EonConnection;

		beforeAll(async () => {
			conn = await connectTestEon();
			await resetDatabase(conn, TEST_DB);
			await conn.exec(`USE ${TEST_DB}`);
			await conn.exec(
				"CREATE STABLE m (ts TIMESTAMP, n INT) TAGS (site VARCHAR(32))",
			);
		}, 60_000);

		afterAll(async () => {
			if (conn) {
				await conn.exec(`DROP DATABASE IF EXISTS ${TEST_DB}`);
				await conn.close();
			}
		}, 30_000);

		it("a refused schemaless point", async () => {
			const error = await failure(() =>
				conn.schemaless([`m,site=${SECRET} n=${SECRET_NUMBER}i 1700000000000`]),
			);
			expect(causeMessage(error)).toContain(SECRET);
			expect(error.message).toContain("eon: schemaless insert failed");
			expect(error.message).toContain("mismatch");
			expect(error.message).not.toContain(SECRET);
			expect(error.message).not.toContain(SECRET_NUMBER);
			expect(error.code).toBeTypeOf("number");
		}, 30_000);

		it("a syntax error in a literal INSERT", async () => {
			const error = await failure(() =>
				conn.exec(
					`INSERT INTO c1 USING m TAGS ('a') VALUES (1700000000000, , '${SECRET}', ${SECRET_NUMBER})`,
				),
			);
			expect(causeMessage(error)).toMatch(
				new RegExp(`${SECRET}|${SECRET_NUMBER}`),
			);
			expect(error.message).toContain(
				"eon: exec failed for [INSERT INTO c1 USING m TAGS]",
			);
			expect(error.message).not.toContain(SECRET);
			expect(error.message).not.toContain(SECRET_NUMBER);
		}, 30_000);

		it("a syntax error in a query", async () => {
			const error = await failure(() =>
				conn.query(`SELECT * FROM m WHERE AND site = '${SECRET}'`),
			);
			expect(causeMessage(error)).toContain(SECRET);
			expect(error.message).not.toContain(SECRET);
		}, 30_000);
	},
);
