/**
 * Eon connection configuration — mirrors atlas `ConnectionConfig` /
 * `AtlasDatabaseConfig` (`AtlasProvider.ts`), adapted for the ws-first TDengine
 * transport: pool sizing / pragmas / migrations / schema-verification are
 * dropped (no pool — D7); URL + auth + a connect-retry knob remain.
 *
 * No env-var reading happens here: the host `config.get("timeseries")` supplies
 * the resolved object (agnostic leaf — eon never touches `process.env`).
 */

/** One TDengine connection's settings. */
export interface EonConnectionConfig {
	/** taosAdapter WebSocket URL, e.g. `ws://localhost:6041`. */
	url: string;
	/** Auth user — supplied to the connector via a setter, never embedded in the URL. */
	user?: string;
	/** Auth password. */
	password?: string;
	/** Default database to `USE` on connect. */
	database?: string;
	/** Cloud / bearer token auth (taosAdapter) — alternative to user/password. */
	token?: string;
	/**
	 * Per-request timeout in ms, passed to `WSConfig.setTimeOut`. Also used as the
	 * overall connect deadline (a stalled WS handshake rejects instead of wedging
	 * boot). Unset → no JS-side connect deadline.
	 */
	timeoutMs?: number;
	/**
	 * Retry the INITIAL connection if it fails — covers a server that starts a
	 * moment after the app (docker-compose / k8s cold start). Extra attempts
	 * beyond the first (default 0 — single attempt). Not a per-query reconnect
	 * (D7: one long-lived connection, no pool).
	 */
	connectRetries?: number;
	/** Base backoff in ms between connect attempts (exponential, capped 30s; default 200). */
	connectBackoffMs?: number;
}

/**
 * Full eon config — single-connection OR multi-connection (atlas parity).
 *
 * 58.2 ships single-connection end-to-end; the `default` / `connections` shape
 * is structural (mirrors atlas) but not yet exercised — named connections /
 * taosAdapter HA slot behind this same shape in a later story.
 */
export interface EonConfig extends EonConnectionConfig {
	/** Name of the default connection when `connections` is set. Defaults to `"primary"`. */
	default?: string;
	/**
	 * Named connections. When present, the top-level `url` is treated as
	 * `connections[default].url`.
	 */
	connections?: Record<string, EonConnectionConfig>;
}

/** Identity helper for typed config authoring — mirrors atlas `defineConfig`. */
export function defineConfig(config: EonConfig): EonConfig {
	return config;
}
