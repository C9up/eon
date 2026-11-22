/**
 * JSON for taosAdapter's text frames, with 64-bit integers kept exact.
 *
 * Offsets, message ids and statement ids are unsigned 64-bit on the server. A
 * plain `JSON.parse` rounds anything past 2^53 to the nearest double, so a TMQ
 * offset read back and handed to `seek` would point somewhere else. Parsing
 * keeps such an integer as a `bigint` (read from its source text), and encoding
 * writes a `bigint` as a bare JSON number.
 */

/** What a decoded reply may hold: plain JSON plus `bigint` for wide integers. */
export type WireValue =
	| string
	| number
	| bigint
	| boolean
	| null
	| WireValue[]
	| { [key: string]: WireValue };

export type WireObject = { [key: string]: WireValue };

const INTEGER = /^-?\d+$/;

function reviveWideInteger(
	this: unknown,
	_key: string,
	value: unknown,
	context?: { source?: string },
): unknown {
	if (
		typeof value === "number" &&
		!Number.isSafeInteger(value) &&
		context?.source !== undefined &&
		INTEGER.test(context.source)
	) {
		return BigInt(context.source);
	}
	return value;
}

function isWireObject(value: unknown): value is WireObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse one text frame; anything but a JSON object is a protocol error. */
export function parseWireObject(text: string): WireObject | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text, reviveWideInteger);
	} catch {
		return undefined;
	}
	return isWireObject(parsed) ? parsed : undefined;
}

/** Serialize a request, writing a `bigint` as a JSON number (never a string). */
export function encodeWire(value: WireValue): string {
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) return `[${value.map(encodeWire).join(",")}]`;
	if (isWireObject(value)) {
		const members = Object.entries(value).map(
			([key, member]) => `${JSON.stringify(key)}:${encodeWire(member)}`,
		);
		return `{${members.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Read a field as a string, or `undefined` when it is absent or another type. */
export function stringField(
	object: WireObject,
	key: string,
): string | undefined {
	const value = object[key];
	return typeof value === "string" ? value : undefined;
}

/** Read an integer field as a `bigint`, or `undefined`. */
export function bigintField(
	object: WireObject,
	key: string,
): bigint | undefined {
	const value = object[key];
	if (typeof value === "bigint") return value;
	if (typeof value === "number" && Number.isInteger(value)) {
		return BigInt(value);
	}
	return undefined;
}

/** Read an integer field as a safe `number`, or `undefined`. */
export function numberField(
	object: WireObject,
	key: string,
): number | undefined {
	const value = object[key];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/** Read a boolean field, or `undefined`. */
export function booleanField(
	object: WireObject,
	key: string,
): boolean | undefined {
	const value = object[key];
	return typeof value === "boolean" ? value : undefined;
}

/** Read an array field, or `undefined`. */
export function arrayField(
	object: WireObject,
	key: string,
): WireValue[] | undefined {
	const value = object[key];
	return Array.isArray(value) ? value : undefined;
}

/** Narrow a value to an object, or `undefined`. */
export function asWireObject(
	value: WireValue | undefined,
): WireObject | undefined {
	return isWireObject(value) ? value : undefined;
}
