/**
 * The raw-block decoder against fixed byte fixtures: every type eon reads,
 * NULL for every type, and the malformed blocks a server must not be able to
 * turn into a crash or a wrong value.
 */
import { describe, expect, it } from "vitest";
import {
	decodeRawBlock,
	scaleDecimal,
	shortestFloat32,
	TaosType,
} from "../src/connection/taos/block.js";
import { rawBlock } from "./fixtures/rawBlock.js";

function view(bytes: Uint8Array): DataView {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe("decodeRawBlock", () => {
	it("decodes every fixed-width type, keeping 64-bit values as bigint", () => {
		const block = rawBlock([
			{ type: TaosType.TIMESTAMP, values: [1704153600000n] },
			{ type: TaosType.BOOL, values: [true] },
			{ type: TaosType.TINYINT, values: [-8] },
			{ type: TaosType.SMALLINT, values: [-300] },
			{ type: TaosType.INT, values: [-70000] },
			{ type: TaosType.BIGINT, values: [-9007199254740993n] },
			{ type: TaosType.UTINYINT, values: [250] },
			{ type: TaosType.USMALLINT, values: [65000] },
			{ type: TaosType.UINT, values: [4000000000] },
			{ type: TaosType.UBIGINT, values: [18446744073709551615n] },
			{ type: TaosType.FLOAT, values: [0.1] },
			{ type: TaosType.DOUBLE, values: [1e-20] },
		]);

		expect(decodeRawBlock(view(block)).rows).toEqual([
			[
				1704153600000n,
				true,
				-8,
				-300,
				-70000,
				-9007199254740993n,
				250,
				65000,
				4000000000,
				18446744073709551615n,
				0.1,
				1e-20,
			],
		]);
	});

	it("decodes text, NCHAR (UCS-4), JSON and binary columns", () => {
		const block = rawBlock([
			{ type: TaosType.VARCHAR, values: ["héllo"] },
			{ type: TaosType.NCHAR, values: ["日本🎌"] },
			{ type: TaosType.JSON, values: ['{"a":1}'] },
			{ type: TaosType.VARBINARY, values: [new Uint8Array([0, 255, 7])] },
			{ type: TaosType.BLOB, values: [new Uint8Array([1, 2])] },
		]);
		const [row] = decodeRawBlock(view(block)).rows;

		expect(row?.slice(0, 3)).toEqual(["héllo", "日本🎌", '{"a":1}']);
		expect(row?.[3]).toBeInstanceOf(ArrayBuffer);
		expect([
			...new Uint8Array(
				row?.[3] instanceof ArrayBuffer ? row[3] : new ArrayBuffer(0),
			),
		]).toEqual([0, 255, 7]);
		expect([
			...new Uint8Array(
				row?.[4] instanceof ArrayBuffer ? row[4] : new ArrayBuffer(0),
			),
		]).toEqual([1, 2]);
	});

	it("gives null for NULL in every type, text included, and keeps the string 'NULL'", () => {
		const block = rawBlock([
			{ type: TaosType.BIGINT, values: [null, 1n] },
			{ type: TaosType.BOOL, values: [null, false] },
			{ type: TaosType.DOUBLE, values: [null, 2.5] },
			{ type: TaosType.VARCHAR, values: [null, "NULL"] },
			{ type: TaosType.NCHAR, values: [null, "x"] },
			{ type: TaosType.VARBINARY, values: [null, new Uint8Array([1])] },
			{ type: TaosType.DECIMAL, values: [null, 15n], scale: 1 },
		]);
		const rows = decodeRawBlock(view(block)).rows;

		expect(rows[0]).toEqual([null, null, null, null, null, null, null]);
		expect(rows[1]?.slice(0, 5)).toEqual([1n, false, 2.5, "NULL", "x"]);
		expect(rows[1]?.[6]).toBe("1.5");
	});

	it("reads both DECIMAL widths at the scale the block carries", () => {
		const block = rawBlock([
			{ type: TaosType.DECIMAL, values: [619900000000n, -1n], scale: 10 },
			{ type: TaosType.DECIMAL64, values: [123456n, -10000n], scale: 4 },
		]);

		expect(decodeRawBlock(view(block)).rows).toEqual([
			["61.9900000000", "12.3456"],
			["-0.0000000001", "-1.0000"],
		]);
	});

	it("crosses a byte of the null bitmap correctly", () => {
		const values = Array.from({ length: 10 }, (_, i) =>
			i % 3 === 0 ? null : i,
		);
		const block = rawBlock([{ type: TaosType.INT, values }]);

		expect(decodeRawBlock(view(block)).rows.map((r) => r[0])).toEqual(values);
	});

	it("refuses a block whose column count is not the result's", () => {
		const block = rawBlock([{ type: TaosType.INT, values: [1] }]);

		expect(() => decodeRawBlock(view(block), 2)).toThrow(
			expect.objectContaining({
				code: "E_EON_DECODE",
				message: expect.stringMatching(/1 column/),
			}),
		);
	});

	it("refuses an unknown type code", () => {
		const block = rawBlock([{ type: TaosType.INT, values: [1] }]);
		new DataView(block.buffer).setInt8(28, 99);

		expect(() => decodeRawBlock(view(block))).toThrow(
			expect.objectContaining({
				code: "E_EON_DECODE",
				message: expect.stringMatching(/type code 99/),
			}),
		);
	});

	it("refuses a truncated block instead of reading past it", () => {
		const block = rawBlock([
			{ type: TaosType.BIGINT, values: [1n, 2n] },
			{ type: TaosType.VARCHAR, values: ["abc", "de"] },
		]);

		for (const cut of [4, 20, 40, block.length - 1]) {
			expect(() => decodeRawBlock(view(block.subarray(0, cut)))).toThrow(
				expect.objectContaining({ code: "E_EON_DECODE" }),
			);
		}
	});

	it("refuses a value offset outside its column", () => {
		const block = rawBlock([{ type: TaosType.VARCHAR, values: ["abc"] }]);
		// The first offset sits right after the header and the length table.
		new DataView(block.buffer).setInt32(28 + 5 + 4, 500, true);

		expect(() => decodeRawBlock(view(block))).toThrow(
			expect.objectContaining({
				code: "E_EON_DECODE",
				message: expect.stringMatching(/offset 500/),
			}),
		);
	});

	it("refuses a value whose length overruns its column", () => {
		const block = rawBlock([{ type: TaosType.VARCHAR, values: ["abc"] }]);
		new DataView(block.buffer).setUint16(28 + 5 + 4 + 4, 60000, true);

		expect(() => decodeRawBlock(view(block))).toThrow(
			expect.objectContaining({
				code: "E_EON_DECODE",
				message: expect.stringMatching(/overruns/),
			}),
		);
	});

	it("refuses a fixed-width column shorter than its rows", () => {
		const block = rawBlock([{ type: TaosType.BIGINT, values: [1n, 2n] }]);
		new DataView(block.buffer).setInt32(28 + 5, 8, true);

		expect(() => decodeRawBlock(view(block))).toThrow(
			expect.objectContaining({
				code: "E_EON_DECODE",
				message: expect.stringMatching(/need 16/),
			}),
		);
	});
});

describe("value helpers", () => {
	it("prints a FLOAT as the shortest decimal that reads back the same", () => {
		expect(shortestFloat32(Math.fround(0.1))).toBe(0.1);
		expect(shortestFloat32(Math.fround(1e-7))).toBe(1e-7);
		expect(shortestFloat32(Math.fround(123456.78))).toBe(123456.78);
		expect(Math.fround(shortestFloat32(Math.fround(Math.PI)))).toBe(
			Math.fround(Math.PI),
		);
	});

	it("scales a decimal's unscaled integer exactly", () => {
		expect(scaleDecimal(5n, 3)).toBe("0.005");
		expect(scaleDecimal(-5n, 3)).toBe("-0.005");
		expect(scaleDecimal(123n, 0)).toBe("123");
		expect(scaleDecimal(10n ** 37n, 10)).toBe(`1${"0".repeat(27)}.0000000000`);
	});
});
