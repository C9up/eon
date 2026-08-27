/**
 * Create the configured database before the first connection selects it.
 *
 * atlas never creates a database — Lucid does not either, because the server
 * image does it: Postgres reads `POSTGRES_DB`, MySQL reads `MYSQL_DATABASE`.
 * TDengine's image has no such variable, so nothing outside the application
 * knows the database should exist, and a connection that names it is refused
 * before any migration can run. That circle — the migration that would create
 * the database cannot run until the database exists — is why eon deviates here
 * and atlas does not.
 *
 * PRECISION and DURATION are create-only in TDengine: a database made by hand
 * at the wrong precision cannot be repaired with `ALTER`. So the side that owns
 * the schema is the side that should create it.
 *
 * Opt-in through `createDatabase` — unset, eon behaves exactly like atlas and
 * expects the database to be there.
 */

import { EonSchema } from "../schema/EonSchema.js";
import type { EonConnectionConfig } from "./config.js";
import type { EonConnection } from "./EonConnection.js";

/** How `ensureDatabase` opens its short-lived admin connection. */
export type EonConnector = (
	config: EonConnectionConfig,
) => Promise<EonConnection>;

/**
 * Run `CREATE DATABASE IF NOT EXISTS` on a connection that selects no database,
 * then close it. A no-op unless `config.createDatabase` is set.
 *
 * The statement is built through {@link EonSchema} rather than string-joined
 * here, so the Rust compiler stays the only place that renders and validates
 * TDengine DDL — including quoting the database name.
 */
export async function ensureDatabase(
	config: EonConnectionConfig,
	connect: EonConnector,
): Promise<void> {
	const requested = config.createDatabase;
	if (requested === undefined || requested === false) return;

	const database = config.database;
	if (database === undefined || database.length === 0) {
		throw new Error(
			"[eon] `createDatabase` is set but no `database` is configured — there is nothing to create.",
		);
	}

	const schema = new EonSchema();
	schema.createDatabase(database, requested === true ? {} : requested);
	const statements = schema.toSQL();

	// The admin connection deliberately drops `database`: the database it names
	// does not exist yet, so selecting it is exactly what fails. `createDatabase`
	// is dropped too — otherwise this would recurse.
	const admin: EonConnectionConfig = {
		url: config.url,
		user: config.user,
		password: config.password,
		token: config.token,
		timeoutMs: config.timeoutMs,
		connectRetries: config.connectRetries,
		connectBackoffMs: config.connectBackoffMs,
	};

	const conn = await connect(admin);
	try {
		for (const sql of statements) {
			await conn.exec(sql);
		}
	} finally {
		await conn.close();
	}
}
