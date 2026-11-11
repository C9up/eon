/**
 * A column named like an `Object.prototype` member decodes to an own property.
 *
 * Identifiers only have to match `[A-Za-z0-9_]`, so `__proto__` and
 * `constructor` are valid aliases. Assigned onto `{}`, `__proto__` hits the
 * inherited accessor: a primitive value vanishes from the row and an object
 * value (VARBINARY decodes to an `ArrayBuffer`) becomes the row's prototype.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import type { EonConnection } from "../src/index.js";
import { connectTestEon } from "../src/testing/index.js";
import { describeIfTdengine } from "../src/testing/vitest.js";

describeIfTdengine("eon row decoding (live TDengine)", () => {
	let conn: EonConnection;

	beforeAll(async () => {
		conn = await connectTestEon();
	});

	afterAll(async () => {
		await conn?.close();
	});

	it("keeps a primitive column aliased __proto__ or constructor as an own key", async () => {
		const [row] = await conn.query(
			"SELECT 1 AS `__proto__`, 2 AS `constructor`",
		);
		expect(row).toBeDefined();
		expect(Object.keys(row ?? {})).toEqual(["__proto__", "constructor"]);
		expect(Object.getOwnPropertyDescriptor(row, "__proto__")?.value).toBe(1n);
		expect(Object.getOwnPropertyDescriptor(row, "constructor")?.value).toBe(2n);
		expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
	});

	it("never re-parents the row with an object value aliased __proto__", async () => {
		const [row] = await conn.query(
			"SELECT CAST('ab' AS VARBINARY(8)) AS `__proto__`",
		);
		expect(row).toBeDefined();
		expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
		expect(Object.hasOwn(row ?? {}, "__proto__")).toBe(true);
	});
});
