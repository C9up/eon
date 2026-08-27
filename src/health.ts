/**
 * A health check for a TDengine connection.
 *
 * Upstream ships one per datastore — `DbConnectionCountCheck` in lucid,
 * `RedisMemoryUsageCheck` in redis — and ream now has the runner
 * (`@c9up/ream/health`). This is eon's.
 *
 * AGNOSTIC BY CONSTRUCTION — the contract is re-declared here rather than
 * imported from `@c9up/ream`. eon must not depend on the framework at runtime,
 * and ream's `HealthChecks` consumes anything of this shape: a `name`, an
 * optional `cacheDuration`, and a `run()`.
 */
import type { EonConnection } from "./connection/EonConnection.js";

/** The result shape ream's health runner consumes. */
export interface EonHealthResult {
	message: string;
	status: "ok" | "warning" | "error";
	finishedAt: Date;
	meta?: Record<string, unknown>;
}

/**
 * Reports whether the server answers, and how slowly.
 *
 * ```ts
 * healthChecks.register([
 *   new EonConnectionCheck(conn).warnWhenSlowerThan(250).cacheFor(30),
 * ])
 * ```
 */
export class EonConnectionCheck {
	readonly #conn: EonConnection;
	#warnAfterMs = 500;

	name = "TDengine connection check";
	/** Seconds to reuse the last result for. A probe every second must not ping every second. */
	cacheDuration?: number;

	constructor(conn: EonConnection) {
		this.#conn = conn;
	}

	/** Rename the check, so two connections stay distinguishable in a report. */
	as(name: string): this {
		this.name = name;
		return this;
	}

	/** Reuse the last result for this many seconds. */
	cacheFor(seconds: number): this {
		this.cacheDuration = seconds;
		return this;
	}

	/**
	 * Warn once a ping takes longer than this.
	 *
	 * A reachable-but-slow server is the case worth reporting: it is not down,
	 * so failing would pull a healthy pod out of rotation, and it is not fine,
	 * so `ok` would hide the thing an operator needs to see.
	 */
	warnWhenSlowerThan(milliseconds: number): this {
		this.#warnAfterMs = milliseconds;
		return this;
	}

	async run(): Promise<EonHealthResult> {
		const startedAt = Date.now();
		try {
			await this.#conn.ping();
			const latency = Date.now() - startedAt;
			const meta = { latency, warningThreshold: this.#warnAfterMs };
			if (latency >= this.#warnAfterMs) {
				return {
					status: "warning",
					message: `TDengine answered in ${latency}ms, above the threshold of ${this.#warnAfterMs}ms`,
					finishedAt: new Date(),
					meta,
				};
			}
			return {
				status: "ok",
				message: "TDengine is reachable",
				finishedAt: new Date(),
				meta,
			};
		} catch (error) {
			return {
				status: "error",
				message: "TDengine is unreachable",
				finishedAt: new Date(),
				// The error itself, not just its message: a caller that logs the
				// report keeps the stack, and a dedup key must never be a message.
				meta: { error, latency: Date.now() - startedAt },
			};
		}
	}
}
