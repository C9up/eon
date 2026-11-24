/**
 * Every eon error is a flare `Exception` of the `errors` namespace, named by
 * its code; a server refusal keeps TDengine's number on `taosCode`.
 */
import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { inContext } from "../src/connection/taos/errors.js";
import {
	compileStatementNative,
	errors,
	quoteIdentNative,
} from "../src/index.js";
import { errors as tmqErrors } from "../src/tmq/index.js";

describe("eon > errors", () => {
	it("exports one flare Exception class per code as `errors`", () => {
		const error = new errors.E_EON_BATCH_SIZE([0]);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toMatchObject({
			code: "E_EON_BATCH_SIZE",
			status: 500,
			message: "batchSize must be a positive integer (got 0)",
		});
		expect(tmqErrors.E_EON_CLOSED).toBe(errors.E_EON_CLOSED);
	});

	it("puts a server refusal's number on taosCode, its code on code", () => {
		const error = new errors.E_EON_SERVER_ERROR("Table does not exist", 9731);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toMatchObject({
			code: "E_EON_SERVER_ERROR",
			taosCode: 9731,
			status: 500,
		});
	});

	it("keeps the class, the code and taosCode when a failure gets its context", () => {
		const server = new errors.E_EON_SERVER_ERROR("syntax error near 'x'", 9);
		const wrapped = inContext(
			server,
			"eon: exec failed for [INSERT]",
			() => "",
		);
		expect(wrapped).toBeInstanceOf(errors.E_EON_SERVER_ERROR);
		expect(wrapped).toMatchObject({
			code: "E_EON_SERVER_ERROR",
			taosCode: 9,
			message: "eon: exec failed for [INSERT]",
			cause: server,
		});

		const timeout = new errors.E_EON_TIMEOUT(["'query' got no reply"]);
		const late = inContext(timeout, "eon: ping failed");
		expect(late).toBeInstanceOf(errors.E_EON_TIMEOUT);
		expect(late.message).toBe("eon: ping failed: 'query' got no reply");

		const other = new errors.E_EON_PARAM_PRECISION(["lossy"]);
		expect(inContext(other, "eon: exec failed")).toBe(other);
		expect(inContext(new TypeError("x"), "eon: exec failed")).toBeInstanceOf(
			errors.E_EON_INTERNAL,
		);
	});

	it("reads the compiler's coded refusals back into eon errors", () => {
		let failure: unknown;
		try {
			quoteIdentNative("a`b");
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(errors.E_UNSAFE_IDENTIFIER);
		expect(failure).toMatchObject({
			code: "E_UNSAFE_IDENTIFIER",
			message: expect.not.stringMatching(/^E_UNSAFE_IDENTIFIER/),
			cause: expect.objectContaining({
				message: expect.stringMatching(/^E_UNSAFE_IDENTIFIER: /),
			}),
		});
		expect(() =>
			compileStatementNative({
				kind: "select",
				table: "meters",
				offset: 5,
			}),
		).toThrow(errors.E_EON_OFFSET_REQUIRES_LIMIT);
	});

	it("gives every compiler refusal a code, malformed inserts and specs included", () => {
		const cases: Array<[object, string]> = [
			[
				{ kind: "insert", table: "child", columns: ["ts"], rows: [] },
				"E_EON_INVALID_INSERT",
			],
			[
				{ kind: "insert", table: "child", columns: ["ts", "v"], rows: [[1]] },
				"E_EON_INVALID_INSERT",
			],
			[
				{
					kind: "insert",
					table: "child",
					using: "meters",
					columns: ["ts"],
					rows: [[1]],
				},
				"E_TAGS_REQUIRED",
			],
			[
				{ kind: "alterStable", name: "meters", changes: [] },
				"E_EON_ALTER_EMPTY",
			],
			[
				{
					kind: "select",
					table: "meters",
					wheres: [{ column: "groupid", operator: "IN", value: 2 }],
				},
				"E_INVALID_WHERE_VALUE",
			],
			[{ kind: "nope" }, "E_EON_INVALID_SPEC"],
		];
		for (const [spec, code] of cases) {
			let failure: unknown;
			try {
				compileStatementNative(spec);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Exception);
			expect(failure).toMatchObject({
				code,
				status: 500,
				message: expect.not.stringMatching(/^E_/),
				cause: expect.objectContaining({
					message: expect.stringMatching(new RegExp(`^${code}: `)),
				}),
			});
		}
	});
});
