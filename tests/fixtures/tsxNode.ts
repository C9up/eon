import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * The command that runs a TypeScript fixture in a child process: this very Node
 * binary with tsx loaded as an import hook.
 *
 * Spawning `node_modules/.bin/tsx` does not work everywhere — on Windows that
 * directory holds `tsx.cmd` / `tsx.ps1` shims, which `spawn` without a shell
 * cannot start (ENOENT). `process.execPath` is a real executable on every
 * platform, and the child is the process under test itself rather than a
 * grandchild behind tsx's CLI relay.
 *
 * tsx is resolved from this package with Node's own lookup, so it is found both
 * in a standalone checkout (the package's node_modules, what CI runs) and in the
 * monorepo (hoisted to the workspace root). It goes to `--import` as a file URL:
 * the child runs in its own cwd, where a bare `tsx` would not resolve, and a raw
 * Windows path (`D:\...`) would be read as a URL with a `d:` scheme.
 */
export function tsxNode(
	script: string,
	args: readonly string[] = [],
): { command: string; args: string[] } {
	const loader = pathToFileURL(
		createRequire(import.meta.url).resolve("tsx"),
	).href;
	return {
		command: process.execPath,
		args: ["--import", loader, script, ...args],
	};
}
