/**
 * Build TDengine raw blocks byte by byte, for the decoder's fixtures.
 *
 * Written from the layout, independently of the decoder: header, per-column
 * type and info, per-column data length, then each column's null bitmap and
 * values (fixed width) or offsets and length-prefixed values (variable).
 */

export type FixtureCell =
	| number
	| bigint
	| boolean
	| string
	| Uint8Array
	| null;

export interface FixtureColumn {
	readonly type: number;
	readonly values: readonly FixtureCell[];
	/** The DECIMAL scale carried in the column info. */
	readonly scale?: number;
}

const WIDTH: Record<number, number> = {
	1: 1,
	2: 1,
	3: 2,
	4: 4,
	5: 8,
	6: 4,
	7: 8,
	9: 8,
	11: 1,
	12: 2,
	13: 4,
	14: 8,
	17: 16,
	21: 8,
};

function fixedBytes(column: FixtureColumn, rows: number): Uint8Array {
	const width = WIDTH[column.type] ?? 0;
	const bitmap = new Uint8Array((rows + 7) >> 3);
	const data = new Uint8Array(width * rows);
	const view = new DataView(data.buffer);
	column.values.forEach((value, row) => {
		if (value === null) {
			bitmap[row >> 3] = (bitmap[row >> 3] ?? 0) | (0x80 >> (row & 7));
			return;
		}
		const at = row * width;
		switch (column.type) {
			case 1:
				view.setInt8(at, value === true ? 1 : 0);
				break;
			case 2:
				view.setInt8(at, Number(value));
				break;
			case 3:
				view.setInt16(at, Number(value), true);
				break;
			case 4:
				view.setInt32(at, Number(value), true);
				break;
			case 5:
			case 9:
			case 21:
				view.setBigInt64(at, BigInt(value.toString()), true);
				break;
			case 6:
				view.setFloat32(at, Number(value), true);
				break;
			case 7:
				view.setFloat64(at, Number(value), true);
				break;
			case 11:
				view.setUint8(at, Number(value));
				break;
			case 12:
				view.setUint16(at, Number(value), true);
				break;
			case 13:
				view.setUint32(at, Number(value), true);
				break;
			case 14:
				view.setBigUint64(at, BigInt(value.toString()), true);
				break;
			case 17: {
				const big = BigInt(value.toString());
				view.setBigUint64(at, BigInt.asUintN(64, big), true);
				view.setBigInt64(at + 8, BigInt.asIntN(64, big >> 64n), true);
				break;
			}
			default:
				throw new Error(`fixture: no fixed width for type ${column.type}`);
		}
	});
	const out = new Uint8Array(bitmap.length + data.length);
	out.set(bitmap, 0);
	out.set(data, bitmap.length);
	return out;
}

function encodeValue(type: number, value: FixtureCell): Uint8Array {
	if (value instanceof Uint8Array) return value;
	const text = String(value);
	if (type === 10) {
		const points = [...text].map((c) => c.codePointAt(0) ?? 0);
		const bytes = new Uint8Array(points.length * 4);
		const view = new DataView(bytes.buffer);
		points.forEach((p, i) => {
			view.setUint32(i * 4, p, true);
		});
		return bytes;
	}
	return new TextEncoder().encode(text);
}

function variableBytes(
	column: FixtureColumn,
	rows: number,
): { head: Uint8Array; data: Uint8Array } {
	const prefix = column.type === 18 ? 4 : 2;
	const offsets = new Uint8Array(rows * 4);
	const offsetView = new DataView(offsets.buffer);
	const parts: Uint8Array[] = [];
	let at = 0;
	column.values.forEach((value, row) => {
		if (value === null) {
			offsetView.setInt32(row * 4, -1, true);
			return;
		}
		const bytes = encodeValue(column.type, value);
		const part = new Uint8Array(prefix + bytes.length);
		const view = new DataView(part.buffer);
		if (prefix === 4) view.setUint32(0, bytes.length, true);
		else view.setUint16(0, bytes.length, true);
		part.set(bytes, prefix);
		offsetView.setInt32(row * 4, at, true);
		parts.push(part);
		at += part.length;
	});
	const data = new Uint8Array(at);
	let cursor = 0;
	for (const part of parts) {
		data.set(part, cursor);
		cursor += part.length;
	}
	return { head: offsets, data };
}

/** A raw block holding these columns (all of the same row count). */
export function rawBlock(columns: readonly FixtureColumn[]): Uint8Array {
	const rows = columns[0]?.values.length ?? 0;
	const bodies: { bytes: Uint8Array; length: number }[] = columns.map(
		(column) => {
			if (WIDTH[column.type] !== undefined) {
				const bytes = fixedBytes(column, rows);
				return { bytes, length: (WIDTH[column.type] ?? 0) * rows };
			}
			const { head, data } = variableBytes(column, rows);
			const bytes = new Uint8Array(head.length + data.length);
			bytes.set(head, 0);
			bytes.set(data, head.length);
			return { bytes, length: data.length };
		},
	);
	const headerSize = 28 + columns.length * 5 + columns.length * 4;
	const total = headerSize + bodies.reduce((s, b) => s + b.bytes.length, 0);
	const block = new Uint8Array(total);
	const view = new DataView(block.buffer);
	view.setInt32(0, 1, true);
	view.setInt32(4, total, true);
	view.setInt32(8, rows, true);
	view.setInt32(12, columns.length, true);
	columns.forEach((column, c) => {
		view.setInt8(28 + c * 5, column.type);
		view.setInt32(28 + c * 5 + 1, column.scale ?? 0, true);
		view.setInt32(
			28 + columns.length * 5 + c * 4,
			bodies[c]?.length ?? 0,
			true,
		);
	});
	let at = headerSize;
	for (const body of bodies) {
		block.set(body.bytes, at);
		at += body.bytes.length;
	}
	return block;
}
