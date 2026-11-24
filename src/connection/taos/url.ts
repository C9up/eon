/**
 * Turn eon's `url` setting into the endpoint taosAdapter serves, and pull out
 * what the URL itself carries.
 *
 * Accepted as before: `ws://host:6041` or `wss://…`, optional `user:pass@`,
 * an optional database as the path (`ws://host:6041/mydb`), and `token` /
 * `bearer_token` in the query string. The request path is always the
 * endpoint's own — `/ws` for SQL, `/rest/tmq` for subscriptions — and only the
 * token parameters are forwarded, so nothing else in the query reaches the
 * server.
 */

import { E_EON_CONNECT } from "../../errors.js";

export type TaosEndpoint = "sql" | "tmq";

export interface TaosTarget {
	/** The URL to open: scheme, host, port, endpoint path, token parameters. */
	readonly url: string;
	readonly user?: string;
	readonly password?: string;
	readonly database?: string;
	readonly bearerToken?: string;
}

const PATHS: Record<TaosEndpoint, string> = { sql: "/ws", tmq: "/rest/tmq" };

function decoded(part: string): string | undefined {
	if (part === "") return undefined;
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}

export function resolveTarget(
	raw: string,
	endpoint: TaosEndpoint,
	settings: { token?: string; tokenParam?: "token" | "bearer_token" } = {},
): TaosTarget {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		// No cause: Node's parse error keeps the whole URL, password included,
		// as an own `input` property, which `console.error(err)` and log
		// serialisers print. The message already says all it says.
		throw new E_EON_CONNECT([
			"the connection URL does not parse; a password holding #, /, ? or \\ must be percent-encoded in the URL, or given in `password`",
		]);
	}
	if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
		throw new E_EON_CONNECT([
			`the connection URL must use ws:// or wss:// (got ${parsed.protocol})`,
		]);
	}
	const target = new URL(
		`${parsed.protocol}//${parsed.host}${PATHS[endpoint]}`,
	);
	const urlToken = parsed.searchParams.get("token") ?? undefined;
	if (urlToken !== undefined && urlToken !== "") {
		target.searchParams.set("token", urlToken);
	}
	if (settings.token !== undefined && settings.token !== "") {
		target.searchParams.set(settings.tokenParam ?? "token", settings.token);
	}
	const bearerToken =
		target.searchParams.get("bearer_token") ??
		parsed.searchParams.get("bearer_token") ??
		undefined;
	if (bearerToken !== undefined && bearerToken !== "") {
		target.searchParams.set("bearer_token", bearerToken);
	}
	const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
	return {
		url: target.toString(),
		user: decoded(parsed.username),
		password: decoded(parsed.password),
		database: path === "" ? undefined : decoded(path),
		bearerToken: bearerToken === "" ? undefined : bearerToken,
	};
}
