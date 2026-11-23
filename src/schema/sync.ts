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

import { createHash } from "node:crypto";
import type { EonConnection } from "../connection/EonConnection.js";
import { E_EON_CHILD_STABLE } from "../errors.js";
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
 * always map to the same child (idempotent create, stable routing for ingest).
 * Pass an explicit `name` to {@link createChildTable} to override.
 *
 * The name is an identity for values a client may choose (a device id, a
 * user-named sensor), so it must be collision resistant: two distinct tag-sets
 * that shared a name would write one series' rows into the other's child table,
 * under the other's tags (TDengine's `USING … TAGS` form ignores the TAGS of an
 * existing child). It is the first 128 bits of a SHA-256 over an unambiguous,
 * length-prefixed encoding of the stable name and each tag's
 * {@link stringifyTagValue} form, behind a version label so a future encoding
 * can never alias this one. `t_` + 32 hex characters.
 */
export function childTableName(
	stableOrEntity: string | SuperTableClass,
	tagValues: unknown[],
): string {
	const hash = createHash("sha256").update(CHILD_NAME_DOMAIN);
	for (const part of childNameParts(stableOrEntity, tagValues)) {
		hash.update(`${Buffer.byteLength(part, "utf8")}:`).update(part, "utf8");
	}
	return `t_${hash.digest("hex").slice(0, CHILD_NAME_HEX_LENGTH)}`;
}

/**
 * The child-table name eon gave a tag-set up to 0.2.15 (64-bit FNV-1a over the
 * `\0`-joined parts). Not collision resistant — a chosen tag value reaches any
 * existing child in seconds — so nothing writes under it any more; it exists so
 * {@link migrateChildTableNames} can recognise the children eon named that way.
 */
export function legacyChildTableName(
	stableOrEntity: string | SuperTableClass,
	tagValues: unknown[],
): string {
	return `t_${fnv1a(childNameParts(stableOrEntity, tagValues).join("\u0000"))}`;
}

/** Version label hashed ahead of the parts (domain separation). */
const CHILD_NAME_DOMAIN = "eon.child.v2\u0000";
/** 32 hex characters = 128 bits of the digest. */
const CHILD_NAME_HEX_LENGTH = 32;

function childNameParts(
	stableOrEntity: string | SuperTableClass,
	tagValues: unknown[],
): string[] {
	const stable =
		typeof stableOrEntity === "string"
			? stableOrEntity
			: requireSuperTableName(stableOrEntity);
	return [stable, ...tagValues.map(stringifyTagValue)];
}

function resolveStableName(options: CreateChildTableOptions): string {
	if (typeof options.stable === "string" && options.stable.length > 0) {
		return options.stable;
	}
	if (options.EntityClass) {
		return requireSuperTableName(options.EntityClass);
	}
	throw new E_EON_CHILD_STABLE();
}

/**
 * A tag value's stable string form for the child-name key. `JSON.stringify`
 * throws on a `bigint` (`TypeError: Do not know how to serialize a BigInt`),
 * which would surface as an opaque crash for any BIGINT `@Tag`; render bigints
 * explicitly so every tag type maps to a deterministic, typed-out string.
 */
export function stringifyTagValue(value: unknown): string {
	if (typeof value === "bigint") return `${value}n`;
	return JSON.stringify(value) ?? "null";
}

/**
 * 64-bit FNV-1a over UTF-16 code units → zero-padded 16-char hex. Only
 * {@link legacyChildTableName} uses it.
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
