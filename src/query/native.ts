/**
 * Native query compiler loader — loads the Rust `eon-query` NAPI binary and
 * exposes the JSON compile boundary to TypeScript.
 *
 * The binary is a single `index.<suffix>.node` at the package root (built by
 * `pnpm --filter @c9up/eon build:napi`). Loading is lazy and fails loud: a miss
 * throws a descriptive error naming the attempted path — never a silent `null`.
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { arch, platform } from "node:process";
import { fileURLToPath } from "node:url";

const require2 = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const platformMap: Record<string, string> = {
	"linux-x64": "linux-x64-gnu",
	"linux-arm64": "linux-arm64-gnu",
	"darwin-x64": "darwin-x64",
	"darwin-arm64": "darwin-arm64",
	"win32-x64": "win32-x64-msvc",
};

interface NativeBinding {
	compileStatement: (specJson: string, dialect: string) => string;
	quoteIdent: (name: string) => string;
}

/** The only dialect eon compiles today (AD10 single-variant seam). */
export type EonDialect = "tdengine";

export interface CompiledStatement {
	statements: string[];
	params: unknown[];
}

let native: NativeBinding | undefined;

/**
 * Resolve and cache the NAPI binding. Throws a descriptive error on an
 * unsupported platform or a missing/unloadable binary — never returns/stores
 * `null`. Called lazily so importing the package does not require a built
 * binary (typecheck, type-only consumers), but any actual compile fails loud.
 */
function loadNative(): NativeBinding {
	if (native) return native;
	const key = `${platform}-${arch}`;
	const suffix = platformMap[key];
	if (!suffix) {
		throw new Error(
			`[E_EON_NAPI_UNSUPPORTED] no eon-query native binary for platform '${key}'. Supported: ${Object.keys(platformMap).join(", ")}.`,
		);
	}
	const binaryPath = join(here, `../../index.${suffix}.node`);
	let binding: NativeBinding;
	try {
		binding = require2(binaryPath);
	} catch (cause) {
		throw new Error(
			`[E_EON_NAPI_NOT_FOUND] eon-query native binary not found at '${binaryPath}'. Build it with: pnpm --filter @c9up/eon build:napi`,
			cause !== undefined ? { cause } : undefined,
		);
	}
	native = binding;
	return binding;
}

/**
 * i64 / nanosecond-timestamp precision guard for the JSON compile boundary.
 *
 * JS `number` cannot represent integers beyond 2^53 (`Number.MAX_SAFE_INTEGER`),
 * yet a TDengine nanosecond `ts` (~1.7e18) or a `BIGINT` column needs full i64.
 * A plain `JSON.stringify` throws on `bigint` and would silently truncate an
 * unsafe-integer `number`; a plain `JSON.parse` truncates any i64 echoed back.
 *
 * Inbound  — `bigint` params are carried as bare integer literals (`serde_json`
 *            reads them as i64); a `number` that is an unsafe integer is already
 *            lossy, so it is rejected loud rather than compiled corrupted.
 * Outbound — integer literals beyond the safe range are revived as `bigint`
 *            using the `JSON.parse` source context (Node ≥22), so no echoed
 *            param is silently narrowed to a lossy double.
 */
function stringifyPrecisionSafe(spec: object): string {
	// A per-call nonce makes the bigint carrier impossible to collide with — or
	// forge from — caller-supplied string/key data: the marker only exists once
	// this call mints it, so no inbound value can already contain it. (A fixed
	// sentinel let a legitimate string param `"__eon_i64__42"` be silently
	// rewritten to the integer 42, and a matching object key produced invalid
	// JSON that hard-failed in serde.)
	const open = `__eon_i64_${randomUUID().replace(/-/g, "")}__`;
	let sawBigInt = false;
	const json = JSON.stringify(spec, (_key, value: unknown) => {
		if (typeof value === "bigint") {
			if (value < -9223372036854775808n || value > 9223372036854775807n) {
				throw new Error(
					`[E_EON_PARAM_PRECISION] bigint param ${value} is outside the signed 64-bit range; TDengine BIGINT cannot represent it (it would silently narrow to a lossy float in the compiler).`,
				);
			}
			sawBigInt = true;
			return `${open}${value.toString()}__`;
		}
		if (typeof value === "number" && !Number.isFinite(value)) {
			// NaN / ±Infinity have no SQL-literal form: `JSON.stringify` maps them to
			// `null`, which would silently become a NULL literal (a dropped LIMIT →
			// full scan, a FILL(VALUE, NULL), or a never-matching WHERE). Reject loud.
			throw new Error(
				`[E_EON_PARAM_PRECISION] non-finite number param (${value}) has no SQL-literal representation; it would silently serialise to NULL.`,
			);
		}
		if (
			typeof value === "number" &&
			Number.isInteger(value) &&
			!Number.isSafeInteger(value)
		) {
			throw new Error(
				`[E_EON_PARAM_PRECISION] integer param ${value} exceeds the JS safe-integer range (2^53) and has already lost precision. Pass i64 / nanosecond-timestamp params as bigint.`,
			);
		}
		return value;
	});
	if (!sawBigInt) return json;
	// Rewrite ONLY the nonced markers this call emitted → bare integer literals
	// that serde_json reads as i64. Anchored to the nonce (hex, no regex
	// metachars), so caller data of the shape `"__eon_i64__42"` is left intact.
	const token = new RegExp(`"${open}(-?\\d+)__"`, "g");
	return json.replace(token, "$1");
}

interface ReviverContext {
	source: string;
}

function parsePrecisionSafe(json: string): CompiledStatement {
	const parsed: CompiledStatement = JSON.parse(
		json,
		(_key, value: unknown, context?: ReviverContext) => {
			if (
				typeof value === "number" &&
				Number.isInteger(value) &&
				!Number.isSafeInteger(value)
			) {
				// An i64 the Rust compiler echoed back as a bare integer literal.
				// Revive it losslessly from the raw source text (Node ≥22). If the
				// runtime does not expose `context.source` the double is already
				// lossy — fail loud rather than silently narrow it (`engines` is
				// only advisory; a bundler/older runtime could reach here).
				if (context !== undefined && /^-?\d+$/.test(context.source)) {
					return BigInt(context.source);
				}
				throw new Error(
					`[E_EON_PARAM_PRECISION] cannot losslessly revive the i64 value ${value}: this runtime does not expose the JSON.parse source context (Node ≥22 required); it would otherwise be silently narrowed to a lossy double.`,
				);
			}
			return value;
		},
	);
	return parsed;
}

/**
 * Compile a tagged statement spec (`{ kind: 'select' | 'insert', ... }`) into
 * `{ statements, params }` via the Rust compiler.
 */
export function compileStatementNative(
	spec: object,
	dialect: EonDialect = "tdengine",
): CompiledStatement {
	const payload = stringifyPrecisionSafe(spec);
	const binding = loadNative();
	const json = binding.compileStatement(payload, dialect);
	return parsePrecisionSafe(json);
}

/** Validate and backtick-quote a TDengine identifier via the Rust seam. */
export function quoteIdentNative(name: string): string {
	return loadNative().quoteIdent(name);
}
