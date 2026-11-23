/**
 * The TDengine wire client's failures. A server refusal is
 * `E_EON_SERVER_ERROR`, with the server's numeric code on `taosCode`; the
 * client's own failures (a closed socket, a timeout, a reply that does not
 * decode…) each have their `E_EON_` class.
 */
import { type ErrorClass, Exception } from "@c9up/flare";
import {
	E_EON_BIND,
	E_EON_CLOSED,
	E_EON_CONNECT,
	E_EON_DECODE,
	E_EON_INTERNAL,
	E_EON_SERVER_ERROR,
	E_EON_SERVER_VERSION,
	E_EON_TIMEOUT,
} from "../../errors.js";

/** A server reply or block that does not match the protocol. */
export function decodeError(detail: string): Exception {
	return new E_EON_DECODE([detail]);
}

/** The client's own failures, by code. */
const CLIENT_ERRORS = new Map<string, ErrorClass<[string]>>([
	["E_EON_BIND", E_EON_BIND],
	["E_EON_CLOSED", E_EON_CLOSED],
	["E_EON_CONNECT", E_EON_CONNECT],
	["E_EON_DECODE", E_EON_DECODE],
	["E_EON_SERVER_VERSION", E_EON_SERVER_VERSION],
	["E_EON_TIMEOUT", E_EON_TIMEOUT],
]);

/**
 * The same failure, with what eon was doing in front of its message: an error
 * of the cause's class (so `code` and `taosCode` stay), the cause kept as
 * `cause`. `detailOf` picks what of the cause's message is shown, for an
 * operation that carries data. Any other eon error passes through as it is;
 * something that is not an eon error is a bug in eon, `E_EON_INTERNAL`.
 */
export function inContext(
	cause: unknown,
	context: string,
	detailOf: (message: string) => string = (message) => message,
): Exception {
	if (!(cause instanceof Exception)) {
		return new E_EON_INTERNAL([context], { cause });
	}
	const detail = detailOf(cause.message);
	const message = detail === "" ? context : `${context}: ${detail}`;
	if (cause instanceof E_EON_SERVER_ERROR) {
		return new E_EON_SERVER_ERROR(message, cause.taosCode, { cause });
	}
	const ClientError =
		cause.code === undefined ? undefined : CLIENT_ERRORS.get(cause.code);
	return ClientError ? new ClientError([message], { cause }) : cause;
}
