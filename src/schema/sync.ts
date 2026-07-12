/**
 * Schema facade — drive TDengine DDL from decorator metadata through a live
 * `EonConnection`. Agnostic leaf: takes the connection structurally, never
 * imports `@c9up/ream`.
 *
 * Every statement is compiled in Rust (`compileStatementNative`) and run through
 * the literal-only `EonConnection.exec` (58.2 D3). Child-table creation renders
 * its tag values as inlined SQL literals (`literal: true`, D4) so `exec` can run
 * it directly; the `?`-bound STMT form lands with ingest in 58.4.
 */

import type { EonConnection } from "../connection/EonConnection.js";
import { compileStatementNative } from "../query/native.js";
import type {
	CreateChildTableSpec,
	DropStableSpec,
} from "./CreateStableSpec.js";
import {
	compileCreateStableSpec,
	requireSuperTableName,
	type SuperTableClass,
} from "./compile.js";

/** Compile a spec and run each resulting statement through the connection. */
async function execSpec(conn: EonConnection, spec: object): Promise<void> {
	const { statements } = compileStatementNative(spec, "tdengine");
	for (const sql of statements) {
		await conn.exec(sql);
	}
}

/** Create the super-table for a decorated class (`CREATE STABLE IF NOT EXISTS`). */
export function syncSuperTable(
	conn: EonConnection,
	EntityClass: SuperTableClass,
): Promise<void> {
	const spec = { ...compileCreateStableSpec(EntityClass), ifNotExists: true };
	return execSpec(conn, spec);
}

/** Options for {@link createChildTable}: identify the stable by name or class. */
export interface CreateChildTableOptions {
	stable?: string;
	EntityClass?: SuperTableClass;
	name: string;
	tags: unknown[];
	ifNotExists?: boolean;
}

/**
 * Create an explicit child table bound to its super-table's tag values
 * (`CREATE TABLE name USING stable TAGS (...)`). Tag values are inlined as typed
 * SQL literals (D4).
 */
export function createChildTable(
	conn: EonConnection,
	options: CreateChildTableOptions,
): Promise<void> {
	const using = resolveStableName(options);
	const spec: CreateChildTableSpec = {
		kind: "createChildTable",
		name: options.name,
		using,
		tags: options.tags,
		ifNotExists: options.ifNotExists ?? true,
		literal: true,
	};
	return execSpec(conn, spec);
}

/** Drop the super-table for a decorated class (`DROP STABLE IF EXISTS`). */
export function dropSuperTable(
	conn: EonConnection,
	EntityClass: SuperTableClass,
): Promise<void> {
	const spec: DropStableSpec = {
		kind: "dropStable",
		name: requireSuperTableName(EntityClass),
		ifExists: true,
	};
	return execSpec(conn, spec);
}

/**
 * A deterministic child-table name for a stable + tag-set, so the same tags
 * always map to the same child (idempotent create, stable routing for 58.4
 * ingest). Dependency-free FNV-1a — no `crypto`, no npm dep (D6). Pass an
 * explicit `name` to {@link createChildTable} to override.
 */
export function childTableName(
	stableOrEntity: string | SuperTableClass,
	tagValues: unknown[],
): string {
	const stable =
		typeof stableOrEntity === "string"
			? stableOrEntity
			: requireSuperTableName(stableOrEntity);
	const key = [stable, ...tagValues.map(stringifyTagValue)].join("\u0000");
	return `t_${fnv1a(key)}`;
}

function resolveStableName(options: CreateChildTableOptions): string {
	if (typeof options.stable === "string" && options.stable.length > 0) {
		return options.stable;
	}
	if (options.EntityClass) {
		return requireSuperTableName(options.EntityClass);
	}
	throw new Error(
		"[E_EON_CHILD_STABLE] createChildTable requires either `stable` (name) or `EntityClass`",
	);
}

/**
 * A tag value's stable string form for the child-name key. `JSON.stringify`
 * throws on a `bigint` (`TypeError: Do not know how to serialize a BigInt`),
 * which would surface as an opaque crash for any BIGINT `@Tag`; render bigints
 * explicitly so every tag type maps to a deterministic, typed-out string.
 */
function stringifyTagValue(value: unknown): string {
	if (typeof value === "bigint") return `${value}n`;
	return JSON.stringify(value) ?? "null";
}

/**
 * 64-bit FNV-1a over UTF-16 code units → zero-padded 16-char hex. 64 bits keeps
 * the child-name collision probability negligible even at millions of distinct
 * tag-sets; a 32-bit space collides ~50% by only ~77k children (realistic
 * per-device TSDB cardinality), which would silently write one device's rows
 * under another's tags. `groupByChild` additionally asserts no two distinct
 * tag-sets ever share a name.
 */
function fnv1a(input: string): string {
	const MASK = (1n << 64n) - 1n;
	const PRIME = 0x00000100000001b3n;
	let hash = 0xcbf29ce484222325n;
	for (let i = 0; i < input.length; i++) {
		hash = (hash ^ BigInt(input.charCodeAt(i))) & MASK;
		hash = (hash * PRIME) & MASK;
	}
	return hash.toString(16).padStart(16, "0");
}
