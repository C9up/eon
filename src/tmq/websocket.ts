/**
 * WebSocket implementation of {@link EonConsumer}, over eon's own taosAdapter
 * TMQ client (`../connection/taos/tmq.js`, ws-only like the SQL connection).
 *
 * Thin by design: the client speaks TMQ. What this adds is the seam (no wire
 * type leaks out), decoded rows keyed by column name, one error type, and two
 * defaults chosen for safety rather than convenience — see `autoCommit` and
 * `offsetReset`.
 */
import { redactUrl } from "../connection/redact.js";
import { defineColumn } from "../connection/row.js";
import { TaosWireError } from "../connection/taos/errors.js";
import {
	TaosConsumer,
	type TaosPartition,
	type TaosPolled,
} from "../connection/taos/tmq.js";
import {
	type EonConsumer,
	type EonConsumerConfig,
	EonConsumerError,
	type EonMessage,
	type EonTopicPartition,
} from "./EonConsumer.js";

/** The commit period the protocol uses when auto-commit is on and none is set. */
const DEFAULT_AUTO_COMMIT_INTERVAL_MS = 5_000;

function wrapError(cause: unknown, message: string): EonConsumerError {
	if (cause instanceof TaosWireError) {
		return new EonConsumerError(`${message}: ${cause.message}`, {
			cause,
			code: cause.code,
		});
	}
	return new EonConsumerError(message, { cause });
}

/**
 * Zip a poll result's column names with its rows. Overloaded like the SQL
 * connection's `runQuery`: the generic row type is the caller's assertion.
 */
function decode<T = Record<string, unknown>>(result: TaosPolled): T[];
function decode(result: TaosPolled): Record<string, unknown>[] {
	if (result.rows.length > 0 && result.columns.length === 0) {
		// The same trap the query decoder guards: rows with no column metadata
		// would each decode to `{}` — silent data loss. Fail loud.
		throw new EonConsumerError(
			`[E_EON_DECODE] poll returned rows but no column metadata for topic '${result.topic}'; cannot decode`,
		);
	}
	return result.rows.map((row) => {
		const record: Record<string, unknown> = {};
		result.columns.forEach((name, index) => {
			defineColumn(record, name, row[index] ?? null);
		});
		return record;
	});
}

function toPartition(p: TaosPartition): EonTopicPartition {
	return {
		topic: p.topic,
		vgroupId: p.vgroupId,
		offset: p.offset,
		begin: p.begin,
		end: p.end,
	};
}

/**
 * Open a consumer against a taosAdapter WebSocket endpoint.
 *
 * `autoCommit` defaults to FALSE, where the protocol defaults it on.
 * Auto-commit acknowledges messages the handler may not have finished with, so
 * a crash drops them silently; a subscription that loses data without saying
 * so is worse than one that redelivers.
 */
export async function connectWsConsumer(
	config: EonConsumerConfig,
): Promise<EonConsumer> {
	let consumer: TaosConsumer;
	try {
		consumer = await TaosConsumer.open({
			url: config.url,
			groupId: config.groupId,
			clientId: config.clientId,
			user: config.user,
			password: config.password,
			token: config.token,
			offsetReset: config.offsetReset ?? "latest",
			autoCommit: config.autoCommit === true,
			autoCommitIntervalMs:
				config.autoCommitIntervalMs ?? DEFAULT_AUTO_COMMIT_INTERVAL_MS,
			withTableName: config.withTableName !== false,
		});
	} catch (error) {
		throw wrapError(
			error,
			`eon: failed to open a consumer on '${redactUrl(config.url)}'`,
		);
	}

	let closed = false;
	function ensureOpen(): void {
		if (closed) {
			throw new EonConsumerError("eon: consumer is closed");
		}
	}

	return {
		async subscribe(topics: string[]): Promise<void> {
			ensureOpen();
			if (topics.length === 0) {
				// An empty subscribe is accepted by the server and then delivers
				// nothing forever — a silent no-op is the worst possible answer.
				throw new EonConsumerError("eon: subscribe() needs at least one topic");
			}
			try {
				await consumer.subscribe(topics);
			} catch (error) {
				throw wrapError(
					error,
					`eon: subscribe failed for [${topics.join(", ")}]`,
				);
			}
		},

		async subscription(): Promise<string[]> {
			ensureOpen();
			try {
				return await consumer.subscription();
			} catch (error) {
				throw wrapError(error, "eon: reading the subscription failed");
			}
		},

		async poll<T = Record<string, unknown>>(
			timeoutMs: number,
		): Promise<EonMessage<T>[]> {
			ensureOpen();
			let polled: TaosPolled[];
			try {
				polled = await consumer.poll(timeoutMs);
			} catch (error) {
				throw wrapError(error, "eon: poll failed");
			}
			return polled.map((result) => ({
				topic: result.topic,
				rows: decode<T>(result),
			}));
		},

		async commit(): Promise<EonTopicPartition[]> {
			ensureOpen();
			try {
				return (await consumer.commit()).map(toPartition);
			} catch (error) {
				throw wrapError(error, "eon: commit failed");
			}
		},

		async assignment(topics?: string[]): Promise<EonTopicPartition[]> {
			ensureOpen();
			try {
				return (await consumer.assignment(topics)).map(toPartition);
			} catch (error) {
				throw wrapError(error, "eon: reading the assignment failed");
			}
		},

		async seek(partition: EonTopicPartition): Promise<void> {
			ensureOpen();
			if (partition.offset === undefined) {
				throw new EonConsumerError("eon: seek() needs an offset");
			}
			try {
				await consumer.seek({
					topic: partition.topic,
					vgroupId: partition.vgroupId,
					offset: partition.offset,
				});
			} catch (error) {
				throw wrapError(error, `eon: seek failed on '${partition.topic}'`);
			}
		},

		async unsubscribe(): Promise<void> {
			ensureOpen();
			try {
				await consumer.unsubscribe();
			} catch (error) {
				throw wrapError(error, "eon: unsubscribe failed");
			}
		},

		async close(): Promise<void> {
			// Idempotent: a `finally` that closes twice must not throw.
			if (closed) return;
			closed = true;
			consumer.close();
		},
	};
}
