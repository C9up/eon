/**
 * A connection URL may carry credentials (`ws://user:pass@host`, `?token=`),
 * which the connector accepts and masks in its own messages. eon's added
 * context must not put them back: a boot failure lands in the crash output.
 */

import { describe, expect, it } from "vitest";
import { redactUrl } from "../src/connection/redact.js";
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
