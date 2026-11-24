/**
 * Eon's errors, one class per code. A caller matches on `error.code` or on
 * `error instanceof errors.E_EON_...`.
 *
 * A refusal from the TDengine server is `E_EON_SERVER_ERROR`, with the
 * server's numeric code on `taosCode`. The query compiler's codes without the
 * `E_EON_` prefix (`E_UNSAFE_IDENTIFIER`, `E_TS_REQUIRED`…) keep their exact
 * spelling.
 */
import { createError, Exception } from "@c9up/flare";

// ─── Lifecycle ──────────────────────────────────────────────────────────────

export const E_EON_NOT_BOOTED = createError<[string]>("%s", "E_EON_NOT_BOOTED");

export const E_EON_ALREADY_BOOTED = createError(
	"EonProvider: boot() has already opened connections; a second boot would overwrite and leak them. Call shutdown() first, or construct a new provider.",
	"E_EON_ALREADY_BOOTED",
);

export const E_EON_BOOT_FAILED = createError<[string]>(
	"%s",
	"E_EON_BOOT_FAILED",
);

export const E_EON_UNKNOWN_CONNECTION = createError<[string]>(
	"EonProvider: default connection '%s' is not defined in config.timeseries.connections",
	"E_EON_UNKNOWN_CONNECTION",
);

export const E_EON_NO_DATABASE = createError(
	"[eon] `createDatabase` is set but no `database` is configured — there is nothing to create.",
	"E_EON_NO_DATABASE",
);

export const E_EON_MISSING_CONNECTION = createError<[string, string]>(
	"SuperTableRepository for '%s' requires an EonConnection (got %s). Check IoC constructor injection is wired.",
	"E_EON_MISSING_CONNECTION",
);

/** No eon-query binary is built for this host. The message lists the supported ones. */
export const E_EON_NAPI_UNSUPPORTED = createError<[fix: string]>(
	"no eon-query native binary for this platform.\n  Fix: %s",
	"E_EON_NAPI_UNSUPPORTED",
);

/**
 * The eon-query binary is missing, fails to load, or is stale. The message
 * names the platform package to install; the load error is its `cause`.
 */
export const E_EON_NAPI_NOT_FOUND = createError<[fix: string]>(
	"eon-query native binary not found or unloadable.\n  Fix: %s",
	"E_EON_NAPI_NOT_FOUND",
);

// ─── Connection and server ──────────────────────────────────────────────────

/** The TDengine server refused a request. `taosCode` is its numeric error code. */
export class E_EON_SERVER_ERROR extends Exception {
	static override code = "E_EON_SERVER_ERROR";

	/** TDengine's numeric error code (`0x2603` "Table does not exist"…). */
	readonly taosCode: number;

	constructor(message: string, taosCode: number, options?: ErrorOptions) {
		super(message, options);
		this.taosCode = taosCode;
	}
}

export const E_EON_CONNECT = createError<[string]>("%s", "E_EON_CONNECT");

export const E_EON_TIMEOUT = createError<[string]>("%s", "E_EON_TIMEOUT");

export const E_EON_CLOSED = createError<[string]>("%s", "E_EON_CLOSED");

export const E_EON_DECODE = createError<[string]>("%s", "E_EON_DECODE");

export const E_EON_BIND = createError<[string]>("%s", "E_EON_BIND");

export const E_EON_SERVER_VERSION = createError<[string]>(
	"the columnar STMT path needs TDengine 3.3.6.0 or later (stmt2); the server is %s",
	"E_EON_SERVER_VERSION",
);

export const E_EON_NO_TOPIC = createError(
	"eon: subscribe() needs at least one topic",
	"E_EON_NO_TOPIC",
);

export const E_EON_SEEK_NO_OFFSET = createError(
	"eon: seek() needs an offset",
	"E_EON_SEEK_NO_OFFSET",
);

// ─── Super-tables and ingest ────────────────────────────────────────────────

export const E_EON_NOT_A_SUPERTABLE = createError<[string]>(
	"%s is not decorated with @SuperTable",
	"E_EON_NOT_A_SUPERTABLE",
);

export const E_EON_NO_TAGS = createError<[string]>(
	"super-table '%s' has no @Tag columns; a child table cannot be routed without tags",
	"E_EON_NO_TAGS",
);

export const E_EON_NO_TIMESTAMP = createError<[string]>(
	"%s",
	"E_EON_NO_TIMESTAMP",
);

export const E_EON_CHILD_STABLE = createError(
	"createChildTable requires either `stable` (name) or `EntityClass`",
	"E_EON_CHILD_STABLE",
);

export const E_EON_CHILD_COLLISION = createError<[string]>(
	"two distinct tag-sets map to the same child table '%s'; refusing to write mismatched rows under one tag-set.",
	"E_EON_CHILD_COLLISION",
);

export const E_EON_CHILD_MIGRATION = createError<[string]>(
	"the child listing of '%s' returned no table name",
	"E_EON_CHILD_MIGRATION",
);

export const E_EON_BATCH_SIZE = createError<[number]>(
	"batchSize must be a positive integer (got %s)",
	"E_EON_BATCH_SIZE",
);

export const E_EON_TYPE = createError<[string, string]>(
	"column/tag '%s' has an unknown or missing type '%s'",
	"E_EON_TYPE",
);

export const E_EON_TS_TYPE = createError<[string, string]>(
	"timestamp '%s' must be a bigint or a safe-integer number (got %s).",
	"E_EON_TS_TYPE",
);

export const E_EON_PARAM_PRECISION = createError<[string]>(
	"%s",
	"E_EON_PARAM_PRECISION",
);

export const E_EON_VALUE_TYPE = createError<[string]>("%s", "E_EON_VALUE_TYPE");

export const E_EON_VALUE_RANGE = createError<[string]>(
	"%s",
	"E_EON_VALUE_RANGE",
);

export const E_EON_TEMPLATE = createError(
	"the compiler returned no statement for the STMT insert template",
	"E_EON_TEMPLATE",
);

export const E_EON_LITERAL_INSERT = createError<[string, number]>(
	"expected exactly one statement for child '%s', got %s",
	"E_EON_LITERAL_INSERT",
);

export const E_EON_HYDRATE_BIGINT = createError<[string]>(
	"%s",
	"E_EON_HYDRATE_BIGINT",
);

// ─── Schemaless (line protocol) ─────────────────────────────────────────────

export const E_EON_SCHEMALESS_SCHEMA = createError<[string]>(
	"%s",
	"E_EON_SCHEMALESS_SCHEMA",
);

export const E_EON_SCHEMALESS_FIELD = createError<[string]>(
	"%s",
	"E_EON_SCHEMALESS_FIELD",
);

export const E_EON_SCHEMALESS_TAG = createError<[string]>(
	"tag '%s' requires a scalar value, not an object/array.",
	"E_EON_SCHEMALESS_TAG",
);

export const E_EON_SCHEMALESS_EMPTY_TAG = createError<[string]>(
	"tag '%s' is an empty string; line protocol requires a non-empty tag value.",
	"E_EON_SCHEMALESS_EMPTY_TAG",
);

export const E_EON_SCHEMALESS_NO_FIELDS = createError<[string]>(
	"point for '%s' has no metric fields; line protocol requires at least one field.",
	"E_EON_SCHEMALESS_NO_FIELDS",
);

export const E_EON_SCHEMALESS_MEASUREMENT = createError(
	"super-table (measurement) name is empty; cannot render a line-protocol point.",
	"E_EON_SCHEMALESS_MEASUREMENT",
);

export const E_EON_SCHEMALESS_CONTROL_CHAR = createError<[string, number]>(
	"%s contains a control character (code %s); line protocol cannot encode it.",
	"E_EON_SCHEMALESS_CONTROL_CHAR",
);

// ─── Query builder ──────────────────────────────────────────────────────────

export const E_EON_INVALID_VALUE = createError<[string]>(
	"%s",
	"E_EON_INVALID_VALUE",
);

export const E_EON_EMPTY_WHERE_GROUP = createError(
	"a where(callback) group added no predicate; an empty `()` is not SQL.",
	"E_EON_EMPTY_WHERE_GROUP",
);

export const E_EON_INVALID_LIMIT = createError<[number]>(
	"limit must be a non-negative safe integer, got %s; a NaN/Infinity would silently drop the LIMIT (full scan).",
	"E_EON_INVALID_LIMIT",
);

export const E_EON_INVALID_OFFSET = createError<[number]>(
	"offset must be a non-negative safe integer, got %s.",
	"E_EON_INVALID_OFFSET",
);

export const E_EON_COMPILE_EMPTY = createError(
	"the compiler returned no SQL statement",
	"E_EON_COMPILE_EMPTY",
);

export const E_EON_UNEXPECTED_PARAMS = createError(
	"a time-series builder SELECT must compile to literal-only SQL, but the compiler returned bound params — literal-mode regression",
	"E_EON_UNEXPECTED_PARAMS",
);

/**
 * An invariant inside eon broke, or the Rust compiler panicked or could not
 * serialize what it compiled: always a bug in eon itself.
 */
export const E_EON_INTERNAL = createError<[string]>("%s", "E_EON_INTERNAL");

// ─── Schema and migrations ──────────────────────────────────────────────────

export const E_EON_ALTER_DB_ONE_OPTION = createError<[string]>(
	"%s",
	"E_EON_ALTER_DB_ONE_OPTION",
);

export const E_EON_MIGRATION_INVALID = createError<[string]>(
	"%s",
	"E_EON_MIGRATION_INVALID",
);

export const E_EON_MIGRATION_LOCKED = createError<[string]>(
	"could not acquire the migration lock — another migration is already running. Wait for it to finish, or clear a stuck lock with forceUnlock() (drops '%s').",
	"E_EON_MIGRATION_LOCKED",
);

// ─── Testing helpers ────────────────────────────────────────────────────────

export const E_EON_FACTORY_STATE = createError<[string, string]>(
	"state '%s' is not defined on %sFactory",
	"E_EON_FACTORY_STATE",
);

export const E_EON_FAKE_UNSUPPORTED = createError<[string]>(
	"%s",
	"E_EON_FAKE_UNSUPPORTED",
);

export const E_EON_TEST_IDENTIFIER = createError<[string]>(
	"%s",
	"E_EON_TEST_IDENTIFIER",
);

export const E_EON_TEST_URL = createError(
	"[eon] connectTestEon requires EON_TEST_URL (a live TDengine taosAdapter WS URL, e.g. ws://localhost:6041).",
	"E_EON_TEST_URL",
);

// ─── Query compiler (Rust) refusals ─────────────────────────────────────────

export const E_EON_INVALID_DURATION = createError<[string]>(
	"%s",
	"E_EON_INVALID_DURATION",
);
export const E_EON_INVALID_FILL = createError<[string]>(
	"%s",
	"E_EON_INVALID_FILL",
);
export const E_EON_FILL_REQUIRES_INTERVAL = createError<[string]>(
	"%s",
	"E_EON_FILL_REQUIRES_INTERVAL",
);
export const E_EON_SLIDING_REQUIRES_INTERVAL = createError<[string]>(
	"%s",
	"E_EON_SLIDING_REQUIRES_INTERVAL",
);
export const E_EON_OFFSET_REQUIRES_LIMIT = createError<[string]>(
	"%s",
	"E_EON_OFFSET_REQUIRES_LIMIT",
);
export const E_EON_INVALID_ORDER_DIRECTION = createError<[string]>(
	"%s",
	"E_EON_INVALID_ORDER_DIRECTION",
);
export const E_EON_INVALID_PSEUDO_COLUMN = createError<[string]>(
	"%s",
	"E_EON_INVALID_PSEUDO_COLUMN",
);
export const E_EON_INVALID_SELECT = createError<[string]>(
	"%s",
	"E_EON_INVALID_SELECT",
);
export const E_EON_INVALID_SELECT_FUNCTION = createError<[string]>(
	"%s",
	"E_EON_INVALID_SELECT_FUNCTION",
);
export const E_EON_INVALID_DB_OPTION = createError<[string]>(
	"%s",
	"E_EON_INVALID_DB_OPTION",
);
export const E_EON_UNKNOWN_DB_OPTION = createError<[string]>(
	"%s",
	"E_EON_UNKNOWN_DB_OPTION",
);
export const E_EON_IMMUTABLE_DB_OPTION = createError<[string]>(
	"%s",
	"E_EON_IMMUTABLE_DB_OPTION",
);
export const E_EON_INVALID_TTL = createError<[string]>(
	"%s",
	"E_EON_INVALID_TTL",
);
export const E_EON_INVALID_WAL_LEVEL = createError<[string]>(
	"%s",
	"E_EON_INVALID_WAL_LEVEL",
);
export const E_EON_INVALID_CACHEMODEL = createError<[string]>(
	"%s",
	"E_EON_INVALID_CACHEMODEL",
);
export const E_EON_INVALID_PRECISION = createError<[string]>(
	"%s",
	"E_EON_INVALID_PRECISION",
);
export const E_EON_KEEP_TOO_SMALL = createError<[string]>(
	"%s",
	"E_EON_KEEP_TOO_SMALL",
);
export const E_TS_REQUIRED = createError<[string]>("%s", "E_TS_REQUIRED");
export const E_TAGS_REQUIRED = createError<[string]>("%s", "E_TAGS_REQUIRED");
export const E_JSON_TAG_RULE = createError<[string]>("%s", "E_JSON_TAG_RULE");
export const E_TYPE_NOT_TAGGABLE = createError<[string]>(
	"%s",
	"E_TYPE_NOT_TAGGABLE",
);
export const E_LENGTH_REQUIRED = createError<[string]>(
	"%s",
	"E_LENGTH_REQUIRED",
);
export const E_NAME_COLLISION = createError<[string]>("%s", "E_NAME_COLLISION");
export const E_INVALID_CLAUSE_TYPE = createError<[string]>(
	"%s",
	"E_INVALID_CLAUSE_TYPE",
);
export const E_INVALID_WHERE_GROUP = createError<[string]>(
	"%s",
	"E_INVALID_WHERE_GROUP",
);
export const E_INVALID_WHERE_VALUE = createError<[string]>(
	"%s",
	"E_INVALID_WHERE_VALUE",
);
export const E_UNSAFE_IDENTIFIER = createError<[string]>(
	"%s",
	"E_UNSAFE_IDENTIFIER",
);
export const E_UNSAFE_LITERAL = createError<[string]>("%s", "E_UNSAFE_LITERAL");
export const E_UNSAFE_OPERATOR = createError<[string]>(
	"%s",
	"E_UNSAFE_OPERATOR",
);

/**
 * An INSERT reached the compiler with no column, no row, a row whose width
 * differs from the column list, or `tags` without `using`.
 */
export const E_EON_INVALID_INSERT = createError<[string]>(
	"%s",
	"E_EON_INVALID_INSERT",
);

/** An ALTER STABLE reached the compiler with no change. */
export const E_EON_ALTER_EMPTY = createError<[string]>(
	"%s",
	"E_EON_ALTER_EMPTY",
);

/** The compiler was asked for a dialect other than `tdengine`. */
export const E_UNSUPPORTED_CLIENT = createError<[string]>(
	"%s",
	"E_UNSUPPORTED_CLIENT",
);

/**
 * The statement the compiler received does not parse. Eon builds every spec
 * itself, so this points at an eon bug or at a spec built by hand.
 */
export const E_EON_INVALID_SPEC = createError<[string]>(
	"%s",
	"E_EON_INVALID_SPEC",
);
