/**
 * `ream configure @c9up/eon` — wire eon into an app in one command.
 *
 * Mirrors atlas's hook: register the provider, seed the env vars, write the
 * config file. Without it the CLI can only report that eon exports no
 * configure(), and every app wires eon by hand.
 */
interface Codemods {
	addProvider(importPath: string): Promise<void>;
	addEnvVars(vars: Record<string, string>): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
}

export async function configure(codemods: Codemods): Promise<void> {
	await codemods.addProvider("@c9up/eon/provider");
	await codemods.addEnvVars({
		TDENGINE_URL: "ws://localhost:6041",
		TDENGINE_USER: "root",
		TDENGINE_PASSWORD: "taosdata",
		TDENGINE_DATABASE: "ream",
	});
	await codemods.writeFile(
		"config/timeseries.ts",
		`import { defineConfig } from '@c9up/eon'

export default defineConfig({
  url: process.env.TDENGINE_URL ?? 'ws://localhost:6041',
  user: process.env.TDENGINE_USER ?? 'root',
  password: process.env.TDENGINE_PASSWORD ?? '',
  database: process.env.TDENGINE_DATABASE ?? 'ream',

  // TDengine's image has no POSTGRES_DB equivalent, so nothing outside the app
  // creates this database — and a connection naming a missing one is refused,
  // before any migration could create it. Precision is create-only, so set it
  // here rather than repairing it later.
  createDatabase: { precision: 'ms' },
})
`,
	);
}
