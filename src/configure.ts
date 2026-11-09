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
	/** Absent from a ream older than the hook; the rules are then added by hand. */
	defineEnvValidations?(definition: {
		leadingComment?: string;
		variables: Record<string, string>;
	}): Promise<string[]>;
}

export async function configure(codemods: Codemods): Promise<void> {
	await codemods.addProvider("@c9up/eon/provider");
	// `change-me`, not TDengine's factory `taosdata`: a deploy that keeps the
	// generated .env must fail to authenticate, not log in as root.
	await codemods.addEnvVars({
		TDENGINE_URL: "ws://localhost:6041",
		TDENGINE_USER: "root",
		TDENGINE_PASSWORD: "change-me",
		TDENGINE_DATABASE: "ream",
	});
	// The config reads these through `env.get` with no fallback, so a missing
	// one fails at boot. The password stays optional for token auth.
	await codemods.defineEnvValidations?.({
		leadingComment: "Variables for the TDengine connection (@c9up/eon)",
		variables: {
			TDENGINE_URL: "Env.schema.string()",
			TDENGINE_USER: "Env.schema.string()",
			TDENGINE_PASSWORD: "Env.schema.string.optional()",
			TDENGINE_DATABASE: "Env.schema.string()",
		},
	});
	await codemods.makeUsingStub(stubsRoot, "config/timeseries.stub");
}
