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
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { describeIfTdengine } from "../src/testing/index.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(
	new URL("./fixtures/boot-shutdown-exit.ts", import.meta.url),
);

describeIfTdengine("EonProvider shutdown (live TDengine)", () => {
	it("lets the process exit after a clean shutdown", async () => {
		const url = process.env.EON_TEST_URL ?? "";
		const exitCode = await new Promise<number | "timeout">((resolve) => {
			const child = spawn(
				`${packageRoot}../../node_modules/.bin/tsx`,
				[script],
				{ env: { ...process.env, EON_TEST_URL: url }, stdio: "ignore" },
			);
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
