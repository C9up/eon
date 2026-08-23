/**
 * Boots an `EonProvider` against the live server, shuts it down, and does
 * nothing else. It must exit on its own — no `process.exit()` here, that is the
 * whole assertion (see `provider-shutdown.integration.test.ts`).
 */
import type { EonAppContext } from "../../src/EonProvider.js";
import { EonProvider } from "../../src/index.js";

const url = process.env.EON_TEST_URL ?? "";

function configGet<T = unknown>(key: string): T | undefined;
function configGet(key: string): unknown {
	return key === "eon"
		? { url, user: "root", password: "taosdata" }
		: undefined;
}

const ctx: EonAppContext = {
	container: { singleton() {} },
	config: { get: configGet },
};

const provider = new EonProvider(ctx);
await provider.boot();
await provider.shutdown();
