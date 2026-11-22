/**
 * The one error the TDengine wire client raises.
 *
 * `code` is the server's numeric error code when the server refused something
 * (a bad statement, a missing database, bad credentials) and is absent when the
 * failure is the client's own — a closed socket, a timeout, a reply that does
 * not decode. Those carry an `E_EON_*` tag at the start of the message instead,
 * so a log line says which of the two it was.
 */
export class TaosWireError extends Error {
	readonly code?: number;

	constructor(message: string, options?: { code?: number; cause?: unknown }) {
		super(
			message,
			options?.cause !== undefined ? { cause: options.cause } : undefined,
		);
		this.name = "TaosWireError";
		this.code = options?.code;
	}
}

/** A server reply or block that does not match the protocol. */
export function decodeError(detail: string): TaosWireError {
	return new TaosWireError(`[E_EON_DECODE] ${detail}`);
}
