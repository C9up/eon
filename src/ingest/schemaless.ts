/**
 * Schemaless line-protocol rendering (story 58.4, AC4).
 *
 * Renders points to InfluxDB line-protocol strings for
 * `EonConnection.schemaless`. This is NOT SQL — it is InfluxDB's line format, so
 * it is rendered in TS (no compiler seam), with the format's own escaping rules
 * applied to the measurement, tag keys/values, and field keys, and string field
 * values double-quoted (context7 `/taosdata/tdengine`, InfluxDB line protocol).
 *
 * Schemaless is a documented ~8–10× slower helper than the STMT path and must
 * NOT be used as the default bulk path (AD5 / AC4).
 */

import type { EonBindKind } from "../connection/EonConnection.js";
import type { ColumnarPlan, IngestPoint } from "./stmt.js";
import { coerceTimestamp } from "./stmt.js";

/**
 * Reject any control character (newline, CR, tab, NUL, …). Line protocol is
 * newline-delimited and cannot encode a control byte in ANY position, so
 * backslash-escaping does not neutralize it — a raw newline in a caller tag or
 * field value would terminate the line and inject a forged point. These bytes
 * must be refused, not escaped (memory `feedback_security_first`).
 */
function assertNoControlChar(value: string, role: string): void {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) {
			throw new Error(
				`[E_EON_SCHEMALESS_CONTROL_CHAR] ${role} contains a control character (code ${code}); line protocol cannot encode it.`,
			);
		}
	}
}

/**
 * Escape a measurement name: comma, space, and backslash. Backslash is escaped
 * too, else a trailing `\` would escape the following delimiter and desync the
 * parser. Control chars are rejected upstream (so no `\s`).
 */
function escapeMeasurement(value: string): string {
	assertNoControlChar(value, "measurement");
	return value.replace(/[\\, ]/g, "\\$&");
}

/** Escape a tag key/value or field key: comma, equals, space, and backslash. */
function escapeKeyOrTag(value: string): string {
	assertNoControlChar(value, "tag/field key or value");
	return value.replace(/[\\,= ]/g, "\\$&");
}

/** Escape a string field value: backslash and double-quote (then wrap in `"`). */
function quoteStringField(value: string): string {
	assertNoControlChar(value, "string field value");
	return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

/**
 * Render one field value into its line-protocol form, typed by its bind kind.
 * Numeric kinds are validated to the same precision/finiteness contract the STMT
 * path enforces (`E_EON_PARAM_PRECISION`): an unsafe-integer `number`, a
 * non-finite float, or a non-numeric value is rejected loud rather than emitted
 * as a lossy/invalid token (e.g. `1e+21i`, `NaNi`) that silently corrupts data.
 */
function renderFieldValue(
	kind: EonBindKind,
	value: unknown,
	property: string,
): string {
	switch (kind) {
		case "int":
		case "bigInt":
		case "smallInt":
		case "tinyInt": {
			// Integer field: the `i` suffix. bigint is exact; a `number` must be a
			// safe integer or it has already lost precision.
			if (typeof value === "bigint") return `${value}i`;
			if (
				typeof value === "number" &&
				Number.isInteger(value) &&
				Number.isSafeInteger(value)
			) {
				return `${value}i`;
			}
			throw new Error(
				`[E_EON_PARAM_PRECISION] integer field '${property}' value ${String(value)} is not a safe integer; pass i64 values as bigint.`,
			);
		}
		case "float":
		case "double":
		case "decimal": {
			if (typeof value === "bigint") return `${value}`;
			if (typeof value === "number" && Number.isFinite(value))
				return `${value}`;
			throw new Error(
				`[E_EON_SCHEMALESS_FIELD] numeric field '${property}' value ${String(value)} is not a finite number.`,
			);
		}
		case "bool":
			if (typeof value !== "boolean") {
				throw new Error(
					`[E_EON_SCHEMALESS_FIELD] bool field '${property}' requires a boolean (got ${typeof value}).`,
				);
			}
			return value ? "true" : "false";
		default:
			// varchar / nchar / varbinary / json / timestamp → quoted string.
			// A non-scalar (object/array) would stringify to "[object Object]" /
			// "a,b" — silent corruption. Reject loud rather than emit garbage.
			if (typeof value === "object") {
				throw new Error(
					`[E_EON_SCHEMALESS_FIELD] string field '${property}' requires a scalar value, not an object/array.`,
				);
			}
			return quoteStringField(String(value));
	}
}

/**
 * Render points to InfluxDB line-protocol lines. The measurement is the
 * super-table name, tags come from the entity's `@Tag` columns, and every
 * present metric column (excluding the timestamp) becomes a field. Points with
 * no fields are skipped (line protocol requires ≥1 field) — reported by the
 * caller, never silently emitted as an invalid line.
 */
export function toLineProtocol(
	plan: ColumnarPlan,
	points: readonly IngestPoint[],
): string[] {
	if (plan.stable === "") {
		throw new Error(
			"[E_EON_SCHEMALESS_MEASUREMENT] super-table (measurement) name is empty; cannot render a line-protocol point.",
		);
	}
	const measurement = escapeMeasurement(plan.stable);
	const lines: string[] = [];

	for (const point of points) {
		const tagParts = plan.tags
			.filter((tag) => point[tag.property] != null)
			.map((tag) => {
				const value = point[tag.property];
				// Tags are not type-checked like fields; a non-scalar (object/array)
				// would stringify to "[object Object]" / "a,b" — silent corruption.
				if (typeof value === "object") {
					throw new Error(
						`[E_EON_SCHEMALESS_TAG] tag '${tag.property}' requires a scalar value, not an object/array.`,
					);
				}
				const raw = String(value);
				// Line protocol forbids an empty tag value (`location=` is invalid and
				// TDengine rejects the whole batch). Reject loud rather than emit a
				// malformed token — a control char in `raw` is caught by escapeKeyOrTag.
				if (raw === "") {
					throw new Error(
						`[E_EON_SCHEMALESS_EMPTY_TAG] tag '${tag.property}' is an empty string; line protocol requires a non-empty tag value.`,
					);
				}
				return `${escapeKeyOrTag(tag.property)}=${escapeKeyOrTag(raw)}`;
			});

		const fieldParts = plan.columns
			.filter(
				(col) =>
					col.property !== plan.tsProperty && point[col.property] != null,
			)
			.map(
				(col) =>
					`${escapeKeyOrTag(col.property)}=${renderFieldValue(col.kind, point[col.property], col.property)}`,
			);

		if (fieldParts.length === 0) {
			throw new Error(
				`[E_EON_SCHEMALESS_NO_FIELDS] point for '${plan.stable}' has no metric fields; line protocol requires at least one field.`,
			);
		}

		const ts = coerceTimestamp(point[plan.tsProperty], plan.tsProperty);
		const prefix =
			tagParts.length > 0
				? `${measurement},${tagParts.join(",")}`
				: measurement;
		lines.push(`${prefix} ${fieldParts.join(",")} ${ts}`);
	}

	return lines;
}
