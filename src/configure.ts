/**
 * `ream configure @c9up/eon` — wire eon into an app in one command.
 *
 * Mirrors atlas's hook: register the provider, seed the env vars, write the
 * config file. Without it the CLI can only report that eon exports no
 * configure(), and every app wires eon by hand.
 */
import { stubsRoot } from "./stubs.js";

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	addEnvVars(vars: Record<string, string>): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
	makeUsingStub(
		stubsRoot: string,
		stubPath: string,
		state?: Record<string, string | number | boolean>,
		options?: { force?: boolean },
	): Promise<{ path: string; contents: string }>;
}

export async function configure(codemods: Codemods): Promise<void> {
	await codemods.addProvider("@c9up/eon/provider");
	await codemods.addEnvVars({
		TDENGINE_URL: "ws://localhost:6041",
		TDENGINE_USER: "root",
		TDENGINE_PASSWORD: "taosdata",
		TDENGINE_DATABASE: "ream",
	});
	await codemods.makeUsingStub(stubsRoot, "config/timeseries.stub");
}
