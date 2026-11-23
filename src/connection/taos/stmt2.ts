/**
 * Encoder for taosAdapter's `stmt2_bind` binary message: one child table's
 * name, tags and columns, bound in a single frame.
 *
 * Frame (little-endian):
 *
 *   uint64 req_id · uint64 stmt_id · uint64 action (9) · int16 version (1) · int32 column index (-1)
 *   then the stmt2 block:
 *   int32 total length · int32 table count · int32 tag count · int32 column count
 *   int32 names offset · int32 tags offset · int32 columns offset      (from the block start)
 *   names:   tables x int16 length (with its NUL) · the names, NUL-terminated
 *   tags:    tables x int32 size · each table's tag columns
 *   columns: tables x int32 size · each table's columns
 *
 * One encoded column:
 *
 *   int32 total length · int32 type · int32 rows · rows x uint8 is-null
 *   uint8 has-lengths · [rows x int32 length] · int32 buffer length · buffer
 *
 * Values are checked against their column's type here, at the last point
 * before bytes: a value that would be written as something else (a string in
 * an INT, a fraction in a BIGINT) raises `E_EON_BIND` instead.
 *
 * DECIMAL binds as its unscaled two's-complement integer — 16 bytes for
 * DECIMAL, 8 for DECIMAL64 — never as text. The previous connector sent the
 * decimal's string, which the server read as those raw bytes: `'61.99'` into
 * DECIMAL(20,10) stored `-4268664320557975669762473403.2597208778`, a different
 * number every run. `stmt2_prepare` reports no scale for a decimal, so the
 * caller passes each decimal column's precision and scale, read from the
 * server's own schema.
 */

import type { Exception } from "@c9up/flare";
import { E_EON_BIND } from "../../errors.js";
import type { EonBindKind, EonBoundColumn } from "../EonConnection.js";
import { TaosType } from "./block.js";

/** The `stmt2_bind` action code in the binary header. */
const BIND_ACTION = 9n;
const MESSAGE_HEADER = 30;
const BLOCK_HEADER = 28;

/** What `stmt2_prepare` reports for one placeholder. */
export interface Stmt2Field {
	readonly name: string;
	readonly type: number;
	readonly precision: number;
	readonly scale: number;
	/** 1 column, 2 tag, 4 table name. */
	readonly bindType: number;
}

export const BindType = { COLUMN: 1, TAG: 2, TABLE_NAME: 4 } as const;

/** A column ready to be written. */
interface EncodedColumn {
	readonly bytes: Uint8Array;
}

/** A decimal column's declared shape. */
export interface DecimalShape {
	readonly precision: number;
	readonly scale: number;
}

const DECIMAL_TEXT = /^([+-])?(\d*)(?:\.(\d*))?$/;

/**
 * A decimal value as its unscaled integer at `shape.scale`. Refused rather than
 * rounded: more fractional digits than the scale, more digits than the
 * precision, an exponent, anything that is not a plain decimal. The messages
 * name the column and row, never the value, which may be business data.
 */
export function unscaledDecimal(
	value: unknown,
	shape: DecimalShape,
	what: string,
): bigint {
	let text: string;
	if (typeof value === "string") text = value.trim();
	else if (typeof value === "bigint") text = value.toString();
	else if (typeof value === "number" && Number.isFinite(value)) {
		text = String(value);
	} else {
		throw bindError(`${what} needs a decimal string (got ${typeof value})`);
	}
	const match = DECIMAL_TEXT.exec(text);
	const integer = match?.[2] ?? "";
	const fraction = match?.[3] ?? "";
	if (match === null || (integer === "" && fraction === "")) {
		throw bindError(
			`${what} is not a plain decimal (pass a string such as 12.50)`,
		);
	}
	const significant = fraction.replace(/0+$/, "");
	if (significant.length > shape.scale) {
		throw bindError(
			`${what} has more than ${shape.scale} fractional digit(s); round it before binding`,
		);
	}
	const digits = `${integer}${fraction.padEnd(shape.scale, "0").slice(0, shape.scale)}`;
	const unscaled = BigInt(digits === "" ? "0" : digits);
	if (unscaled.toString().length > shape.precision && unscaled !== 0n) {
		throw bindError(
			`${what} does not fit DECIMAL(${shape.precision},${shape.scale})`,
		);
	}
	return match[1] === "-" ? -unscaled : unscaled;
}

const utf8 = new TextEncoder();

function bindError(detail: string): Exception {
	return new E_EON_BIND([detail]);
}

const FIXED_TYPE: Partial<
	Record<EonBindKind, { type: number; width: number }>
> = {
	timestamp: { type: TaosType.TIMESTAMP, width: 8 },
	bool: { type: TaosType.BOOL, width: 1 },
	tinyInt: { type: TaosType.TINYINT, width: 1 },
	smallInt: { type: TaosType.SMALLINT, width: 2 },
	int: { type: TaosType.INT, width: 4 },
	bigInt: { type: TaosType.BIGINT, width: 8 },
	float: { type: TaosType.FLOAT, width: 4 },
	double: { type: TaosType.DOUBLE, width: 8 },
};

const VARIABLE_TYPE: Partial<Record<EonBindKind, number>> = {
	varchar: TaosType.VARCHAR,
	nchar: TaosType.NCHAR,
	varbinary: TaosType.VARBINARY,
	json: TaosType.JSON,
};

/** Milliseconds → the database's unit, for a `Date` bound to a TIMESTAMP. */
function dateToTimestamp(date: Date, precision: number): bigint {
	const ms = BigInt(date.getTime());
	if (precision === 1) return ms * 1000n;
	if (precision === 2) return ms * 1_000_000n;
	return ms;
}

function toBigInt(value: unknown, what: string): bigint {
	if (typeof value === "bigint") return value;
	if (typeof value === "number" && Number.isSafeInteger(value)) {
		return BigInt(value);
	}
	throw bindError(`${what} needs an integer (got ${typeof value})`);
}

function toNumber(value: unknown, what: string): number {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	throw bindError(`${what} needs a number (got ${typeof value})`);
}

function writeFixed(
	view: DataView,
	at: number,
	kind: EonBindKind,
	value: unknown,
	precision: number,
	what: string,
): void {
	switch (kind) {
		case "timestamp":
			view.setBigInt64(
				at,
				value instanceof Date
					? dateToTimestamp(value, precision)
					: toBigInt(value, what),
				true,
			);
			return;
		case "bool":
			if (typeof value !== "boolean") {
				throw bindError(`${what} needs a boolean (got ${typeof value})`);
			}
			view.setInt8(at, value ? 1 : 0);
			return;
		case "tinyInt":
			view.setInt8(at, Number(toBigInt(value, what)));
			return;
		case "smallInt":
			view.setInt16(at, Number(toBigInt(value, what)), true);
			return;
		case "int":
			view.setInt32(at, Number(toBigInt(value, what)), true);
			return;
		case "bigInt":
			view.setBigInt64(at, toBigInt(value, what), true);
			return;
		case "float":
			view.setFloat32(at, toNumber(value, what), true);
			return;
		case "double":
			view.setFloat64(at, toNumber(value, what), true);
			return;
		default:
			throw bindError(`${what}: ${kind} is not a fixed-width kind`);
	}
}

function variableBytes(
	kind: EonBindKind,
	value: unknown,
	what: string,
): Uint8Array {
	if (kind === "varbinary") {
		if (value instanceof ArrayBuffer) return new Uint8Array(value);
		if (ArrayBuffer.isView(value)) {
			return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		}
	}
	if (kind === "json" && typeof value === "object" && value !== null) {
		return utf8.encode(JSON.stringify(value));
	}
	if (typeof value === "string") return utf8.encode(value);
	if (
		typeof value === "number" ||
		typeof value === "bigint" ||
		typeof value === "boolean"
	) {
		return utf8.encode(String(value));
	}
	throw bindError(`${what} needs a string (got ${typeof value})`);
}

/** The fixed-width layout of a decimal column, from the server's type. */
function decimalLayout(
	type: number | undefined,
	what: string,
): { type: number; width: number } {
	if (type === TaosType.DECIMAL) return { type, width: 16 };
	if (type === TaosType.DECIMAL64) return { type, width: 8 };
	throw bindError(
		`${what} is bound as a decimal but the column is type ${type}`,
	);
}

/**
 * Encode one column. `type` is the server's type for the placeholder (a
 * DECIMAL(≤18) column is DECIMAL64 there); `decimal` is a decimal column's
 * precision and scale.
 */
export function encodeColumn(
	column: EonBoundColumn,
	options: {
		type?: number;
		precision: number;
		decimal?: DecimalShape;
		what: string;
	},
): EncodedColumn {
	const rows = column.values.length;
	const fixed =
		column.kind === "decimal"
			? decimalLayout(options.type, options.what)
			: FIXED_TYPE[column.kind];
	if (fixed !== undefined) {
		const total = 17 + (fixed.width + 1) * rows;
		const bytes = new Uint8Array(total);
		const view = new DataView(bytes.buffer);
		view.setInt32(0, total, true);
		view.setInt32(4, fixed.type, true);
		view.setInt32(8, rows, true);
		const dataAt = 12 + rows + 1 + 4;
		view.setUint8(12 + rows, 0);
		view.setInt32(12 + rows + 1, fixed.width * rows, true);
		column.values.forEach((value, row) => {
			if (value === null || value === undefined) {
				view.setUint8(12 + row, 1);
				return;
			}
			const at = dataAt + row * fixed.width;
			const what = `${options.what} row ${row}`;
			if (column.kind !== "decimal") {
				writeFixed(view, at, column.kind, value, options.precision, what);
				return;
			}
			if (options.decimal === undefined) {
				throw bindError(`${what}: the scale of this decimal column is unknown`);
			}
			const unscaled = unscaledDecimal(value, options.decimal, what);
			if (fixed.width === 8) {
				view.setBigInt64(at, unscaled, true);
				return;
			}
			view.setBigUint64(at, BigInt.asUintN(64, unscaled), true);
			view.setBigInt64(at + 8, BigInt.asIntN(64, unscaled >> 64n), true);
		});
		return { bytes };
	}
	const kindType = VARIABLE_TYPE[column.kind];
	if (kindType === undefined) {
		throw bindError(`${options.what}: unknown bind kind ${column.kind}`);
	}
	const type = kindType;
	const values = column.values.map((value, row) =>
		value === null || value === undefined
			? undefined
			: variableBytes(column.kind, value, `${options.what} row ${row}`),
	);
	const dataLength = values.reduce(
		(sum, value) => sum + (value?.length ?? 0),
		0,
	);
	const total = 17 + 5 * rows + dataLength;
	const bytes = new Uint8Array(total);
	const view = new DataView(bytes.buffer);
	view.setInt32(0, total, true);
	view.setInt32(4, type, true);
	view.setInt32(8, rows, true);
	let at = 12;
	for (const value of values) {
		view.setUint8(at, value === undefined ? 1 : 0);
		at += 1;
	}
	view.setUint8(at, 1);
	at += 1;
	for (const value of values) {
		view.setInt32(at, value?.length ?? 0, true);
		at += 4;
	}
	view.setInt32(at, dataLength, true);
	at += 4;
	for (const value of values) {
		if (value === undefined) continue;
		bytes.set(value, at);
		at += value.length;
	}
	return { bytes };
}

export interface Stmt2Table {
	readonly name?: string;
	readonly tags: readonly EonBoundColumn[];
	readonly columns: readonly EonBoundColumn[];
}

/**
 * Build the `stmt2_bind` frame for one table against the prepared fields.
 * The counts are checked first: a tag or column list that does not match the
 * placeholders is refused before anything is sent.
 */
export function encodeBind(
	reqId: bigint,
	stmtId: bigint,
	fields: readonly Stmt2Field[],
	table: Stmt2Table,
	decimals: ReadonlyMap<string, DecimalShape> = new Map(),
): ArrayBuffer {
	const tagFields = fields.filter((f) => f.bindType === BindType.TAG);
	const columnFields = fields.filter((f) => f.bindType === BindType.COLUMN);
	const hasName = fields.some((f) => f.bindType === BindType.TABLE_NAME);
	if (table.tags.length !== tagFields.length) {
		throw bindError(
			`${table.tags.length} tag value(s) for ${tagFields.length} tag placeholder(s)`,
		);
	}
	if (table.columns.length !== columnFields.length) {
		throw bindError(
			`${table.columns.length} column(s) for ${columnFields.length} column placeholder(s)`,
		);
	}
	const rows = table.columns[0]?.values.length ?? 0;
	for (const column of table.columns) {
		if (column.values.length !== rows) {
			throw bindError("columns of one table must have the same number of rows");
		}
	}
	const precision = fields[0]?.precision ?? 0;
	const tags = table.tags.map((tag, i) =>
		encodeColumn(tag, {
			type: tagFields[i]?.type,
			precision,
			decimal: decimals.get(tagFields[i]?.name ?? ""),
			what: `tag ${tagFields[i]?.name ?? i}`,
		}),
	);
	const columns = table.columns.map((column, i) =>
		encodeColumn(column, {
			type: columnFields[i]?.type,
			precision,
			decimal: decimals.get(columnFields[i]?.name ?? ""),
			what: `column ${columnFields[i]?.name ?? i}`,
		}),
	);

	let name: Uint8Array | undefined;
	if (hasName) {
		if (table.name === undefined || table.name === "") {
			throw bindError("the statement binds a table name and none was given");
		}
		name = utf8.encode(table.name);
		if (name.includes(0))
			throw bindError("a table name cannot hold a NUL byte");
		if (name.length + 1 > 0x7fff) throw bindError("the table name is too long");
	}
	const namesSize = name === undefined ? 0 : 2 + name.length + 1;
	const tagsSize =
		tags.length > 0 ? 4 + tags.reduce((s, t) => s + t.bytes.length, 0) : 0;
	const columnsSize =
		columns.length > 0
			? 4 + columns.reduce((s, c) => s + c.bytes.length, 0)
			: 0;
	const blockSize = BLOCK_HEADER + namesSize + tagsSize + columnsSize;

	const frame = new Uint8Array(MESSAGE_HEADER + blockSize);
	const view = new DataView(frame.buffer);
	view.setBigUint64(0, reqId, true);
	view.setBigUint64(8, stmtId, true);
	view.setBigUint64(16, BIND_ACTION, true);
	view.setInt16(24, 1, true);
	view.setInt32(26, -1, true);

	const block = MESSAGE_HEADER;
	view.setInt32(block, blockSize, true);
	view.setInt32(block + 4, 1, true);
	view.setInt32(block + 8, tags.length, true);
	view.setInt32(block + 12, columns.length, true);
	view.setInt32(block + 16, name === undefined ? 0 : BLOCK_HEADER, true);
	view.setInt32(
		block + 20,
		tags.length > 0 ? BLOCK_HEADER + namesSize : 0,
		true,
	);
	view.setInt32(
		block + 24,
		columns.length > 0 ? BLOCK_HEADER + namesSize + tagsSize : 0,
		true,
	);

	let at = block + BLOCK_HEADER;
	if (name !== undefined) {
		view.setInt16(at, name.length + 1, true);
		at += 2;
		frame.set(name, at);
		at += name.length;
		frame[at] = 0;
		at += 1;
	}
	if (tags.length > 0) {
		view.setInt32(at, tagsSize - 4, true);
		at += 4;
		for (const tag of tags) {
			frame.set(tag.bytes, at);
			at += tag.bytes.length;
		}
	}
	if (columns.length > 0) {
		view.setInt32(at, columnsSize - 4, true);
		at += 4;
		for (const column of columns) {
			frame.set(column.bytes, at);
			at += column.bytes.length;
		}
	}
	return frame.buffer;
}
