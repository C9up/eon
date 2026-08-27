/**
 * A service that shuts down must actually EXIT. Closing every connection is not
 * enough — the TDengine connector keeps process-global handles, so without
 * `destroyEonConnector()` (which `EonProvider.shutdown()` calls) the process
 * hangs forever after a clean shutdown.
 *
 * Asserting that only makes sense in a child process: the test runner's own
 * process is not the thing under test.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { describeIfTdengine } from "../src/testing/vitest.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
/**
 * Where `tsx` lives. It is a devDependency of this package, so in a standalone
 * checkout (what CI runs) it sits in the package's own node_modules; in the
 * monorepo pnpm hoists it to the workspace root instead. Looking only at the
 * root made this test spawn a binary that does not exist in CI — the child
 * never started, never exited, and the test read that as "the process hung".
 */
function tsxBinary(): string {
	const candidates = [
		path.join(packageRoot, "node_modules", ".bin", "tsx"),
		path.join(packageRoot, "..", "..", "node_modules", ".bin", "tsx"),
	];
	const found = candidates.find((c) => existsSync(c));
	if (found === undefined) {
		throw new Error(`tsx not found — looked in:\n  ${candidates.join("\n  ")}`);
	}
	return found;
}

const script = fileURLToPath(
	new URL("./fixtures/boot-shutdown-exit.ts", import.meta.url),
);

describeIfTdengine("EonProvider shutdown (live TDengine)", () => {
	it("lets the process exit after a clean shutdown", async () => {
		const url = process.env.EON_TEST_URL ?? "";
		const exitCode = await new Promise<number | "timeout">((resolve) => {
			const child = spawn(tsxBinary(), [script], {
				env: { ...process.env, EON_TEST_URL: url },
				stdio: "ignore",
			});
			// Generous: a cold ws handshake plus boot/shutdown. If the connector
			// handles were left alive, the child never exits and we hit this.
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve("timeout");
			}, 30_000);
			child.on("exit", (code) => {
				clearTimeout(timer);
				resolve(code ?? -1);
			});
		});
		expect(exitCode).toBe(0);
	}, 60_000);
});
