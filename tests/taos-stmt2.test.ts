/**
 * The stmt2 bind encoder, byte for byte: column layout, the frame's offsets,
 * DECIMAL as an unscaled integer, and the values it refuses to write.
 */
import { describe, expect, it } from "vitest";
import { TaosType } from "../src/connection/taos/block.js";
import {
	BindType,
	encodeBind,
	encodeColumn,
	type Stmt2Field,
	unscaledDecimal,
} from "../src/connection/taos/stmt2.js";

function words(bytes: Uint8Array, from: number, count: number): number[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return Array.from({ length: count }, (_, i) =>
		view.getInt32(from + i * 4, true),
	);
}

describe("encodeColumn", () => {
	it("lays out a fixed-width column with its null flags", () => {
		const { bytes } = encodeColumn(
			{ kind: "int", values: [7, null] },
			{ precision: 0, what: "c" },
		);

		// total · type · rows · 2 null flags · has-lengths · buffer length · 2 x int32
		expect(bytes.length).toBe(17 + 5 * 2);
		expect(words(bytes, 0, 3)).toEqual([27, TaosType.INT, 2]);
		expect([...bytes.subarray(12, 15)]).toEqual([0, 1, 0]);
		expect(words(bytes, 15, 3)).toEqual([8, 7, 0]);
	});

	it("lays out a variable column with per-row lengths", () => {
		const { bytes } = encodeColumn(
			{ kind: "varchar", values: ["ab", null, "é"] },
			{ precision: 0, what: "c" },
		);

		expect(words(bytes, 0, 3)).toEqual([17 + 15 + 4, TaosType.VARCHAR, 3]);
		expect([...bytes.subarray(12, 16)]).toEqual([0, 1, 0, 1]);
		expect(words(bytes, 16, 4)).toEqual([2, 0, 2, 4]);
		expect(new TextDecoder().decode(bytes.subarray(32))).toBe("abé");
	});

	it("writes a DECIMAL as its unscaled two's-complement integer", () => {
		const { bytes } = encodeColumn(
			{ kind: "decimal", values: ["-0.0000000001"] },
			{
				type: TaosType.DECIMAL,
				precision: 0,
				decimal: { precision: 20, scale: 10 },
				what: "c",
			},
		);
		const view = new DataView(bytes.buffer);

		expect(view.getInt32(4, true)).toBe(TaosType.DECIMAL);
		expect(view.getBigInt64(18, true)).toBe(-1n);
		expect(view.getBigInt64(26, true)).toBe(-1n);
	});

	it("refuses a value of the wrong type instead of coercing it", () => {
		expect(() =>
			encodeColumn({ kind: "int", values: ["7"] }, { precision: 0, what: "c" }),
		).toThrow(/E_EON_BIND.*integer/);
		expect(() =>
			encodeColumn({ kind: "bool", values: [1] }, { precision: 0, what: "c" }),
		).toThrow(/E_EON_BIND.*boolean/);
		expect(() =>
			encodeColumn(
				{ kind: "decimal", values: ["1"] },
				{ type: TaosType.VARCHAR, precision: 0, what: "c" },
			),
		).toThrow(/E_EON_BIND.*column is type 8/);
	});
});

describe("unscaledDecimal", () => {
	const shape = { precision: 10, scale: 4 };

	it("scales strings, numbers and bigints exactly", () => {
		expect(unscaledDecimal("12.3456", shape, "c")).toBe(123456n);
		expect(unscaledDecimal("-1", shape, "c")).toBe(-10000n);
		expect(unscaledDecimal(".5", shape, "c")).toBe(5000n);
		expect(unscaledDecimal("1.20000", shape, "c")).toBe(12000n);
		expect(unscaledDecimal(2.5, shape, "c")).toBe(25000n);
		expect(unscaledDecimal(3n, shape, "c")).toBe(30000n);
	});

	it("refuses rather than rounds, and never echoes the value", () => {
		for (const bad of ["1.00001", "1e3", "abc", "", "123456789"]) {
			let message = "";
			try {
				unscaledDecimal(bad, shape, "column amount row 0");
			} catch (error) {
				message = error instanceof Error ? error.message : "";
			}
			expect(message).toMatch(/^\[E_EON_BIND\] column amount row 0/);
			if (bad !== "") expect(message).not.toContain(bad);
		}
	});
});

describe("encodeBind", () => {
	const fields: Stmt2Field[] = [
		{
			name: "tbname",
			type: TaosType.VARCHAR,
			precision: 0,
			scale: 0,
			bindType: BindType.TABLE_NAME,
		},
		{
			name: "s",
			type: TaosType.NCHAR,
			precision: 0,
			scale: 0,
			bindType: BindType.TAG,
		},
		{
			name: "ts",
			type: TaosType.TIMESTAMP,
			precision: 0,
			scale: 0,
			bindType: BindType.COLUMN,
		},
	];

	it("writes the header, the offsets and the NUL-terminated table name", () => {
		const frame = new Uint8Array(
			encodeBind(5n, 9n, fields, {
				name: "d0",
				tags: [{ kind: "nchar", values: ["x"] }],
				columns: [{ kind: "timestamp", values: [1n] }],
			}),
		);
		const view = new DataView(frame.buffer);

		expect(view.getBigUint64(0, true)).toBe(5n);
		expect(view.getBigUint64(8, true)).toBe(9n);
		expect(view.getBigUint64(16, true)).toBe(9n);
		expect(view.getInt16(24, true)).toBe(1);
		expect(view.getInt32(26, true)).toBe(-1);
		const [total, tables, tags, columns, names, tagsAt, columnsAt] = words(
			frame,
			30,
			7,
		);
		expect(total).toBe(frame.length - 30);
		expect([tables, tags, columns, names]).toEqual([1, 1, 1, 28]);
		expect(tagsAt).toBe(28 + 2 + 3);
		expect(view.getInt16(30 + 28, true)).toBe(3);
		expect([...frame.subarray(30 + 30, 30 + 33)]).toEqual([100, 48, 0]);
		// names (2 + 3) · tag sizes (4) · one NCHAR tag column (17 + 5 + 1)
		expect(columnsAt).toBe(28 + 5 + 4 + 23);
	});

	it("refuses tag or column counts that do not match the placeholders", () => {
		expect(() =>
			encodeBind(1n, 1n, fields, { name: "d0", tags: [], columns: [] }),
		).toThrow(/E_EON_BIND.*0 tag value/);
		expect(() =>
			encodeBind(1n, 1n, fields, {
				name: "d0",
				tags: [{ kind: "nchar", values: ["x"] }],
				columns: [],
			}),
		).toThrow(/E_EON_BIND.*0 column/);
	});
});
