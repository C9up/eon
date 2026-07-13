/**
 * Literal SQL INSERT ingest planning (story 58.4, AC5) — the convenience /
 * fallback path that runs through the literal-only `EonConnection.exec`.
 *
 * Because `exec` takes literal SQL (no bind params, 58.2 D3), the value literals
 * are rendered by the **Rust compiler's `literal: true` INSERT mode** (D6, OQ1),
 * reusing the single `render_literal` injection seam. This module NEVER
 * string-builds SQL or interpolates a value — it assembles a JSON `InsertSpec`
 * and hands it to `compileStatementNative`. It groups points by child table
 * (the `USING … TAGS` auto-create form) exactly like the STMT path.
 */

import { compileStatementNative } from "../query/native.js";
import type { ColumnarPlan, IngestPoint } from "./stmt.js";
import { assertColumnValue, coerceTimestamp, groupByChild } from "./stmt.js";

/**
 * Build one literal `INSERT … USING <stable> TAGS(...) VALUES(...)` statement per
 * child table. Every value is validated against its declared bind kind up front —
 * the timestamp through `coerceTimestamp` (rejecting fractional/string/unsafe
 * inputs the compile boundary alone would pass, e.g. `1700000000000.5` or a date
 * string), other columns through `assertColumnValue` — so the literal path is
 * exactly as precision- and type-safe as the STMT path, and the Rust compiler
 * renders only the vetted literals (never TS interpolation).
 */
export function buildLiteralInserts(
	plan: ColumnarPlan,
	points: readonly IngestPoint[],
): string[] {
	const columnNames = plan.columns.map((c) => c.property);
	const tagProps = plan.tags.map((t) => t.property);
	const statements: string[] = [];

	for (const group of groupByChild(plan.stable, tagProps, points)) {
		const rows = group.rows.map((point) =>
			plan.columns.map((col) => {
				if (col.property === plan.tsProperty) {
					return coerceTimestamp(point[col.property], col.property);
				}
				const value = point[col.property] ?? null;
				assertColumnValue(value, col.kind, col.property);
				return value;
			}),
		);
		const compiled = compileStatementNative(
			{
				kind: "insert",
				table: group.table,
				using: plan.stable,
				tags: group.tagValues.map((v, i) => {
					const value = v ?? null;
					const tag = plan.tags[i];
					if (tag !== undefined)
						assertColumnValue(value, tag.kind, tag.property);
					return value;
				}),
				columns: columnNames,
				rows,
				literal: true,
			},
			"tdengine",
		);
		const [sql, ...rest] = compiled.statements;
		if (sql === undefined || rest.length > 0) {
			throw new Error(
				`[E_EON_LITERAL_INSERT] expected exactly one statement for child '${group.table}', got ${compiled.statements.length}`,
			);
		}
		statements.push(sql);
	}

	return statements;
}
