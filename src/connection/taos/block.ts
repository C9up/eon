/**
 * Decoder for TDengine's raw result block — the binary payload of a query's
 * `fetch_raw_block` reply and of each block in a TMQ message.
 *
 * Layout (little-endian):
 *
 *   int32 version · int32 length · int32 rows · int32 cols · int32 flags · uint64 group id
 *   cols x (int8 type · int32 info)            — info's low byte is a DECIMAL's scale
 *   cols x int32 data length
 *   per column:
 *     fixed width:  ceil(rows / 8) null bitmap (MSB first) · rows x width
 *     var length:   rows x int32 offset (-1 = NULL) · data, each value led by
 *                   its byte length (uint16, uint32 for BLOB)
 *
 * Every read is bounds-checked against the block: a short, truncated or
 * inconsistent block, or a type code this decoder does not know, raises
 * `E_EON_DECODE` instead of reading past the end or guessing.
 *
 * Two things the previous connector got wrong are right here. A NULL is `null`
 * for every type — it pushed the string "NULL", so a nullable VARCHAR could not
 * tell an empty cell from the four characters. And FLOAT / DOUBLE keep their
 * value — it rounded them through `toFixed(5)` / `toFixed(15)`, which turned
 * `1e-7` into `0`.
 */

import { decodeError } from "./errors.js";

/** TDengine column type codes. */
export const TaosType = {
	NULL: 0,
	BOOL: 1,
	TINYINT: 2,
	SMALLINT: 3,
	INT: 4,
	BIGINT: 5,
	FLOAT: 6,
	DOUBLE: 7,
	VARCHAR: 8,
	TIMESTAMP: 9,
	NCHAR: 10,
	UTINYINT: 11,
	USMALLINT: 12,
	UINT: 13,
	UBIGINT: 14,
	JSON: 15,
	VARBINARY: 16,
	DECIMAL: 17,
	BLOB: 18,
	GEOMETRY: 20,
	DECIMAL64: 21,
} as const;

/** Bytes per value of each fixed-width type. */
const FIXED_WIDTH = new Map<number, number>([
	[TaosType.NULL, 1],
	[TaosType.BOOL, 1],
	[TaosType.TINYINT, 1],
	[TaosType.SMALLINT, 2],
	[TaosType.INT, 4],
	[TaosType.BIGINT, 8],
	[TaosType.FLOAT, 4],
	[TaosType.DOUBLE, 8],
	[TaosType.TIMESTAMP, 8],
	[TaosType.UTINYINT, 1],
	[TaosType.USMALLINT, 2],
	[TaosType.UINT, 4],
	[TaosType.UBIGINT, 8],
	[TaosType.DECIMAL, 16],
	[TaosType.DECIMAL64, 8],
]);

const VARIABLE = new Set<number>([
	TaosType.VARCHAR,
	TaosType.NCHAR,
	TaosType.JSON,
	TaosType.VARBINARY,
	TaosType.BLOB,
	TaosType.GEOMETRY,
]);

/** Whether a type code is one the decoder (and the bind encoder) knows. */
export function isKnownType(type: number): boolean {
	return FIXED_WIDTH.has(type) || VARIABLE.has(type);
}

const HEADER_BYTES = 28;
const utf8 = new TextDecoder("utf-8");

/** One decoded block: its column types and its rows, values in column order. */
export interface DecodedBlock {
	readonly types: readonly number[];
	readonly rows: unknown[][];
}

/** Bounds-checked little-endian reads over one block. */
class Reader {
	readonly #view: DataView;

	constructor(view: DataView) {
		this.#view = view;
	}

	get length(): number {
		return this.#view.byteLength;
	}

	need(offset: number, bytes: number, what: string): void {
		if (
			!Number.isInteger(offset) ||
			offset < 0 ||
			bytes < 0 ||
			offset + bytes > this.#view.byteLength
		) {
			throw decodeError(
				`raw block truncated reading ${what} (${bytes} byte(s) at ${offset}, block is ${this.#view.byteLength})`,
			);
		}
	}

	int8(offset: number, what: string): number {
		this.need(offset, 1, what);
		return this.#view.getInt8(offset);
	}

	uint8(offset: number, what: string): number {
		this.need(offset, 1, what);
		return this.#view.getUint8(offset);
	}

	int32(offset: number, what: string): number {
		this.need(offset, 4, what);
		return this.#view.getInt32(offset, true);
	}

	view(): DataView {
		return this.#view;
	}

	bytes(offset: number, length: number, what: string): Uint8Array {
		this.need(offset, length, what);
		return new Uint8Array(
			this.#view.buffer,
			this.#view.byteOffset + offset,
			length,
		);
	}
}

/**
 * Decode a raw block. `expectedColumns`, when given, is the column count the
 * caller's metadata announced; a block with another count does not belong to
 * that result and is refused.
 */
export function decodeRawBlock(
	view: DataView,
	expectedColumns?: number,
): DecodedBlock {
	const reader = new Reader(view);
	const rows = reader.int32(8, "row count");
	const cols = reader.int32(12, "column count");
	if (rows < 0 || cols < 0) {
		throw decodeError(
			`raw block announces ${rows} row(s) and ${cols} column(s)`,
		);
	}
	if (expectedColumns !== undefined && cols !== expectedColumns) {
		throw decodeError(
			`raw block has ${cols} column(s), the result announced ${expectedColumns}`,
		);
	}

	const types: number[] = [];
	const scales: number[] = [];
	for (let c = 0; c < cols; c++) {
		const at = HEADER_BYTES + c * 5;
		const type = reader.int8(at, "column type");
		if (!isKnownType(type)) {
			throw decodeError(`unknown TDengine type code ${type} in column ${c}`);
		}
		types.push(type);
		scales.push(reader.int32(at + 1, "column info") & 0xff);
	}

	const lengthsAt = HEADER_BYTES + cols * 5;
	const lengths: number[] = [];
	for (let c = 0; c < cols; c++) {
		const length = reader.int32(lengthsAt + c * 4, "column length");
		if (length < 0) throw decodeError(`column ${c} has length ${length}`);
		lengths.push(length);
	}

	const columns: unknown[][] = [];
	let cursor = lengthsAt + cols * 4;
	for (let c = 0; c < cols; c++) {
		const type = types[c] ?? TaosType.NULL;
		const length = lengths[c] ?? 0;
		const width = FIXED_WIDTH.get(type);
		if (width !== undefined) {
			const bitmapBytes = (rows + 7) >> 3;
			const dataAt = cursor + bitmapBytes;
			if (length < rows * width) {
				throw decodeError(
					`column ${c} holds ${length} byte(s), ${rows} value(s) of type ${type} need ${rows * width}`,
				);
			}
			reader.need(cursor, bitmapBytes + length, `column ${c}`);
			columns.push(
				readFixedColumn(reader, cursor, dataAt, rows, type, scales[c] ?? 0),
			);
			cursor = dataAt + length;
		} else {
			const dataAt = cursor + rows * 4;
			reader.need(cursor, rows * 4 + length, `column ${c}`);
			columns.push(
				readVariableColumn(reader, cursor, dataAt, length, rows, type),
			);
			cursor = dataAt + length;
		}
	}

	const out: unknown[][] = [];
	for (let r = 0; r < rows; r++) {
		const row: unknown[] = [];
		for (const column of columns) row.push(column[r] ?? null);
		out.push(row);
	}
	return { types, rows: out };
}

function isNullBit(reader: Reader, bitmapAt: number, row: number): boolean {
	const byte = reader.uint8(bitmapAt + (row >> 3), "null bitmap");
	return (byte & (0x80 >> (row & 7))) !== 0;
}

function readFixedColumn(
	reader: Reader,
	bitmapAt: number,
	dataAt: number,
	rows: number,
	type: number,
	scale: number,
): unknown[] {
	const view = reader.view();
	const out: unknown[] = [];
	for (let r = 0; r < rows; r++) {
		if (type === TaosType.NULL || isNullBit(reader, bitmapAt, r)) {
			out.push(null);
			continue;
		}
		switch (type) {
			case TaosType.BOOL:
				out.push(view.getInt8(dataAt + r) !== 0);
				break;
			case TaosType.TINYINT:
				out.push(view.getInt8(dataAt + r));
				break;
			case TaosType.UTINYINT:
				out.push(view.getUint8(dataAt + r));
				break;
			case TaosType.SMALLINT:
				out.push(view.getInt16(dataAt + r * 2, true));
				break;
			case TaosType.USMALLINT:
				out.push(view.getUint16(dataAt + r * 2, true));
				break;
			case TaosType.INT:
				out.push(view.getInt32(dataAt + r * 4, true));
				break;
			case TaosType.UINT:
				out.push(view.getUint32(dataAt + r * 4, true));
				break;
			case TaosType.BIGINT:
			case TaosType.TIMESTAMP:
				out.push(view.getBigInt64(dataAt + r * 8, true));
				break;
			case TaosType.UBIGINT:
				out.push(view.getBigUint64(dataAt + r * 8, true));
				break;
			case TaosType.FLOAT:
				out.push(shortestFloat32(view.getFloat32(dataAt + r * 4, true)));
				break;
			case TaosType.DOUBLE:
				out.push(view.getFloat64(dataAt + r * 8, true));
				break;
			case TaosType.DECIMAL64:
				out.push(scaleDecimal(view.getBigInt64(dataAt + r * 8, true), scale));
				break;
			case TaosType.DECIMAL: {
				const low = view.getBigUint64(dataAt + r * 16, true);
				const high = view.getBigInt64(dataAt + r * 16 + 8, true);
				out.push(scaleDecimal((high << 64n) | low, scale));
				break;
			}
			default:
				throw decodeError(`type code ${type} is not fixed-width`);
		}
	}
	return out;
}

function readVariableColumn(
	reader: Reader,
	offsetsAt: number,
	dataAt: number,
	dataLength: number,
	rows: number,
	type: number,
): unknown[] {
	const prefix = type === TaosType.BLOB ? 4 : 2;
	const view = reader.view();
	const out: unknown[] = [];
	for (let r = 0; r < rows; r++) {
		const offset = reader.int32(offsetsAt + r * 4, "value offset");
		if (offset === -1) {
			out.push(null);
			continue;
		}
		if (offset < 0 || offset + prefix > dataLength) {
			throw decodeError(
				`value offset ${offset} is outside its column (${dataLength} bytes)`,
			);
		}
		const at = dataAt + offset;
		const size =
			prefix === 4 ? view.getUint32(at, true) : view.getUint16(at, true);
		if (offset + prefix + size > dataLength) {
			throw decodeError(`a ${size}-byte value overruns its column`);
		}
		const bytes = reader.bytes(at + prefix, size, "value");
		switch (type) {
			case TaosType.VARCHAR:
			case TaosType.JSON:
				out.push(utf8.decode(bytes));
				break;
			case TaosType.NCHAR:
				out.push(decodeUcs4(bytes));
				break;
			default:
				// VARBINARY, BLOB, GEOMETRY: a copy, never a view into the frame.
				out.push(bytes.slice().buffer);
		}
	}
	return out;
}

/** NCHAR travels as UCS-4: one little-endian uint32 per code point. */
function decodeUcs4(bytes: Uint8Array): string {
	if (bytes.length % 4 !== 0) {
		throw decodeError(
			`an NCHAR value of ${bytes.length} bytes is not whole code points`,
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const points: number[] = [];
	for (let i = 0; i < bytes.length; i += 4) {
		const point = view.getUint32(i, true);
		const valid = point <= 0x10ffff && (point < 0xd800 || point > 0xdfff);
		points.push(valid ? point : 0xfffd);
	}
	let text = "";
	for (let i = 0; i < points.length; i += 4096) {
		text += String.fromCodePoint(...points.slice(i, i + 4096));
	}
	return text;
}

/**
 * The shortest decimal that reads back as the same binary32 value: `0.1f` is
 * `0.1`, not `0.10000000149011612`, and nothing is rounded away.
 */
export function shortestFloat32(value: number): number {
	if (!Number.isFinite(value) || value === 0) return value;
	for (let digits = 1; digits <= 9; digits++) {
		const candidate = Number(value.toPrecision(digits));
		if (Math.fround(candidate) === value) return candidate;
	}
	return value;
}

/** A DECIMAL's unscaled integer, as the exact decimal string. */
export function scaleDecimal(unscaled: bigint, scale: number): string {
	const negative = unscaled < 0n;
	const digits = (negative ? -unscaled : unscaled).toString();
	if (scale <= 0) return `${negative ? "-" : ""}${digits}`;
	const padded = digits.padStart(scale + 1, "0");
	const integer = padded.slice(0, padded.length - scale);
	const fraction = padded.slice(padded.length - scale);
	return `${negative ? "-" : ""}${integer}.${fraction}`;
}
