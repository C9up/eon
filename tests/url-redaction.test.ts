/**
 * A connection URL may carry credentials (`ws://user:pass@host`, `?token=`),
 * which the connector accepts and masks in its own messages. eon's added
 * context must not put them back: a boot failure lands in the crash output.
 */

import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { redactUrl } from "../src/connection/redact.js";
import { TaosSocket } from "../src/connection/taos/socket.js";
import type { EonAppContext } from "../src/EonProvider.js";
import { connectWsEon, EonProvider } from "../src/index.js";
import { connectWsConsumer } from "../src/tmq/websocket.js";

const SECRET_URL =
	"ws://root:Sup3rS3cret@127.0.0.1:1/?token=T0kS3cret&bearer_token=B3arS3cret";
const SECRETS = ["Sup3rS3cret", "T0kS3cret", "B3arS3cret"];

function expectNoSecret(text: string): void {
	for (const secret of SECRETS) expect(text).not.toContain(secret);
}

async function failure(run: () => Promise<unknown>): Promise<unknown> {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error("expected a failure");
}

describe("redactUrl", () => {
	it("masks the password and every query value, keeps scheme, user and host", () => {
		const redacted = redactUrl(SECRET_URL);
		expectNoSecret(redacted);
		expect(redacted).toBe(
			"ws://root:***@127.0.0.1:1/?token=***&bearer_token=***",
		);
	});

	it("leaves a credential-free URL as it was", () => {
		expect(redactUrl("ws://localhost:6041")).toBe("ws://localhost:6041/");
	});

	it("prints nothing of an URL it cannot parse", () => {
		const redacted = redactUrl("ws://root:pa ss@ho st:6041");
		expect(redacted).not.toContain("pa ss");
		expect(redacted).toBe("<unparseable URL>");
	});
});

describe("connection errors never echo URL credentials", () => {
	it("connectWsEon", async () => {
		const error = await failure(() =>
			connectWsEon({ url: SECRET_URL, timeoutMs: 5_000 }),
		);
		expect(error).toBeInstanceOf(Error);
		expectNoSecret(String(error));
		expect(String(error)).toContain("ws://root:***@127.0.0.1:1/");
	}, 20_000);

	it("EonProvider.boot", async () => {
		function configGet<T = unknown>(key: string): T | undefined;
		function configGet(key: string): unknown {
			return key === "eon" ? { url: SECRET_URL, timeoutMs: 5_000 } : undefined;
		}
		const ctx: EonAppContext = {
			container: { singleton() {} },
			config: { get: configGet },
		};
		const error = await failure(() => new EonProvider(ctx).boot());
		expectNoSecret(String(error));
	}, 20_000);

	it("connectWsConsumer", async () => {
		const error = await failure(() =>
			connectWsConsumer({ url: SECRET_URL, groupId: "g" }),
		);
		expect(error).toBeInstanceOf(Error);
		expectNoSecret(String(error));
	}, 20_000);
});

/**
 * Everything a sink can print of an error: Node's own printing (what
 * `console.error(err)` writes), and every own property of every error down
 * the cause chain, enumerable or not (what a log serialiser or an error
 * tracker copies).
 */
function everythingPrinted(error: unknown): string {
	const parts = [inspect(error, { depth: 10, showHidden: true })];
	let current: unknown = error;
	for (let depth = 0; depth < 10 && current instanceof Error; depth++) {
		for (const key of Reflect.ownKeys(current)) {
			parts.push(String(key), inspect(Reflect.get(current, key), { depth: 5 }));
		}
		current = current.cause;
	}
	return parts.join("\n");
}

describe("a connection URL that does not parse leaves nothing of itself in the error", () => {
	// An unencoded #, /, ? or \ in the password is what makes the URL
	// unparseable, so the credential is there exactly when parsing fails.
	const passwords = ["S3cr#tP4ss", "S3cr/tP4ss", "S3cr?tP4ss", "S3cr\\tP4ss"];

	for (const password of passwords) {
		const url = `ws://root:${password}@127.0.0.1:6041`;

		it(`connectWsEon, password ${JSON.stringify(password)}`, async () => {
			const error = await failure(() =>
				connectWsEon({ url, connectRetries: 0, timeoutMs: 200 }),
			);
			expect(error).toBeInstanceOf(Error);
			expect(everythingPrinted(error)).not.toContain(password);
			expect(everythingPrinted(error)).not.toContain("tP4ss");
			expect(String(error)).toMatch(/must be percent-encoded/);
		});
	}

	const url = "ws://root:S3cr#tP4ss@127.0.0.1:6041";

	it("TaosSocket.open, handed a URL its WebSocket refuses", async () => {
		const error = await failure(() => TaosSocket.open(url));
		expect(error).toMatchObject({ code: "E_EON_CONNECT" });
		expect(everythingPrinted(error)).not.toContain("tP4ss");
	});

	it("connectWsConsumer", async () => {
		const error = await failure(() => connectWsConsumer({ url, groupId: "g" }));
		expect(error).toBeInstanceOf(Error);
		expect(everythingPrinted(error)).not.toContain("tP4ss");
		expect(String(error)).toMatch(/does not parse/);
	});

	it("EonProvider.boot", async () => {
		function configGet<T = unknown>(key: string): T | undefined;
		function configGet(key: string): unknown {
			return key === "eon"
				? { url, connectRetries: 0, timeoutMs: 200 }
				: undefined;
		}
		const ctx: EonAppContext = {
			container: { singleton() {} },
			config: { get: configGet },
		};
		const error = await failure(() => new EonProvider(ctx).boot());
		expect(error).toMatchObject({ code: "E_EON_BOOT_FAILED" });
		expect(everythingPrinted(error)).not.toContain("tP4ss");
		expect(String(error)).toMatch(/does not parse/);
	});
});
