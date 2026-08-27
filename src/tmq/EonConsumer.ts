/**
 * Data subscription — TDengine's TMQ, as a transport-neutral seam.
 *
 * eon could write and read; it could not be TOLD when something arrived. TMQ is
 * how TDengine streams changes to a consumer group, and without it an app that
 * wants a live dashboard has to poll a `SELECT` on a timer.
 *
 * Mirrors {@link EonConnection}'s posture: this file declares the contract and
 * leaks no ws type, so a native transport can implement the same seam later
 * without any consumer changing.
 */

/** Where a consumer group starts when it has no committed offset. */
export type EonOffsetReset = "earliest" | "latest" | "none";

export interface EonConsumerConfig {
	/** taosAdapter WebSocket endpoint, e.g. `ws://localhost:6041`. */
	url: string;
	/**
	 * The consumer group.
	 *
	 * Two consumers sharing a group split the partitions between them; two with
	 * DIFFERENT groups each receive everything. Getting this wrong is the
	 * classic way to either duplicate every message or silently process half.
	 */
	groupId: string;
	/** Identifies this consumer within its group, in server-side diagnostics. */
	clientId?: string;
	user?: string;
	password?: string;
	token?: string;
	database?: string;
	/** Where to start with no committed offset. Default: `latest`. */
	offsetReset?: EonOffsetReset;
	/**
	 * Commit offsets on a timer.
	 *
	 * Default FALSE, which deviates from the driver: auto-commit acknowledges
	 * messages the app may not have finished with, so a crash loses them with no
	 * trace. Opt in once your handler is idempotent.
	 */
	autoCommit?: boolean;
	/** Auto-commit period in ms. Ignored unless `autoCommit` is true. */
	autoCommitIntervalMs?: number;
	/** Include the source table name with each message. Default: true. */
	withTableName?: boolean;
}

/** One topic's worth of a poll. */
export interface EonMessage<T = Record<string, unknown>> {
	topic: string;
	rows: T[];
}

/** A position in one topic's virtual group. */
export interface EonTopicPartition {
	topic: string;
	vgroupId: number;
	offset?: bigint;
	begin?: bigint;
	end?: bigint;
}

/**
 * A subscribed consumer.
 *
 * The lifecycle is `subscribe` → `poll` in a loop → `commit` → `close`.
 */
export interface EonConsumer {
	/** Start receiving from these topics. Replaces any previous subscription. */
	subscribe(topics: string[]): Promise<void>;
	/** The topics currently subscribed to, as the server sees them. */
	subscription(): Promise<string[]>;
	/**
	 * Wait up to `timeoutMs` for messages. Resolves to an empty array on timeout
	 * — that is a normal quiet period, not an error.
	 */
	poll<T = Record<string, unknown>>(
		timeoutMs: number,
	): Promise<EonMessage<T>[]>;
	/** Acknowledge everything polled so far. */
	commit(): Promise<EonTopicPartition[]>;
	/** The partitions assigned to this consumer. */
	assignment(topics?: string[]): Promise<EonTopicPartition[]>;
	/** Move one partition to an offset. */
	seek(partition: EonTopicPartition): Promise<void>;
	/** Stop receiving, without closing the connection. */
	unsubscribe(): Promise<void>;
	/** Release the consumer. Safe to call twice. */
	close(): Promise<void>;
}

/**
 * Raised by every consumer operation.
 *
 * Follows {@link EonConnectionError}'s shape — the connector's numeric code is
 * carried verbatim rather than swallowed, so a caller can branch on it.
 */
export class EonConsumerError extends Error {
	/** The underlying TDengine numeric error code, when the failure came from the connector. */
	readonly code?: number;

	constructor(message: string, options?: { cause?: unknown; code?: number }) {
		super(
			message,
			options?.cause !== undefined ? { cause: options.cause } : undefined,
		);
		this.name = "EonConsumerError";
		this.code = options?.code;
	}
}
