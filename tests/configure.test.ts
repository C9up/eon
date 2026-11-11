import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { configure } from "../src/configure.js";
import { defineConfig } from "../src/connection/config.js";

interface RecordedFile {
	path: string;
	content: string;
	options?: { force?: boolean };
}

interface FakeState {
	providers: string[];
	envVars: Record<string, string>;
	files: RecordedFile[];
}

/**
 * Read a stub the way `codemods.makeUsingStub` does.
 *
 * The real file, not a fixture: a test that stubbed this out would pass with
 * a stub that does not exist.
 */
function renderStub(
	stubsRoot: string,
	stubPath: string,
	state: Record<string, string | number | boolean>,
): { to: string; body: string } {
	const raw = readFileSync(resolve(stubsRoot, stubPath), "utf8");
	const [, front = "", body = ""] = raw.split(/^---\r?\n/m, 3);
	const declared = /^to:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? "";
	const render = (text: string): string =>
		text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) =>
			state[key] === undefined ? match : String(state[key]),
		);
	return { to: render(declared), body: render(body) };
}

function createFakeCodemods(): {
	state: FakeState;
	codemods: {
		addProvider: (importPath: string) => Promise<void>;
		addEnvVars: (vars: Record<string, string>) => Promise<void>;
		writeFile: (
			path: string,
			content: string,
			options?: { force?: boolean },
		) => Promise<void>;
		makeUsingStub: (
			stubsRoot: string,
			stubPath: string,
			state?: Record<string, string | number | boolean>,
			options?: { force?: boolean },
		) => Promise<{ path: string; contents: string }>;
	};
} {
	const state: FakeState = { providers: [], envVars: {}, files: [] };
	return {
		state,
		codemods: {
			async addProvider(importPath) {
				state.providers.push(importPath);
			},
			async addEnvVars(vars) {
				Object.assign(state.envVars, vars);
			},
			async writeFile(path, content, options) {
				state.files.push({ path, content, options });
			},
			async makeUsingStub(stubsRoot, stubPath, stubState = {}, options) {
				const { to, body } = renderStub(stubsRoot, stubPath, stubState);
				state.files.push({ path: to, content: body, options });
				return { path: to, contents: body };
			},
		},
	};
}

describe("eon > configure", () => {
	it("registers the provider, env vars and config/timeseries.ts", async () => {
		const { state, codemods } = createFakeCodemods();
		await configure(codemods);

		expect(state.providers).toEqual(["@c9up/eon/provider"]);
		expect(state.envVars).toMatchObject({
			TDENGINE_URL: "ws://localhost:6041",
			TDENGINE_USER: "ream",
			TDENGINE_DATABASE: "ream",
		});
		expect(state.files).toHaveLength(1);
		expect(state.files[0]?.path).toBe("config/timeseries.ts");
	});

	it("writes a config EonProvider can actually read", () => {
		// EonProvider looks up config `timeseries` first, then `eon`. A file at
		// any other path, or a shape missing `url`, leaves the container binding
		// unresolvable — and nothing says so until boot.
		const shape = defineConfig({
			url: "ws://localhost:6041",
			user: "ream",
			password: "",
			database: "ream",
		});
		expect(shape.url).toBe("ws://localhost:6041");
	});

	it("seeds a placeholder password, never TDengine's factory one", async () => {
		const { state, codemods } = createFakeCodemods();
		await configure(codemods);

		// `taosdata` is the stock superuser password of every TDengine image: an
		// app deployed with the generated .env would authenticate as root with a
		// public password.
		expect(state.envVars.TDENGINE_PASSWORD).toBe("change-me");
		expect(Object.values(state.envVars)).not.toContain("taosdata");
	});

	it("seeds an application account, never the root superuser", async () => {
		const { state, codemods } = createFakeCodemods();
		await configure(codemods);

		// Replacing only the password placeholder must not leave the app logged
		// in as the superuser: the generated identity is an application account.
		expect(state.envVars.TDENGINE_USER).toBe("ream");
		expect(Object.values(state.envVars)).not.toContain("root");
	});

	it("writes a config with no fallback connection values", async () => {
		const { state, codemods } = createFakeCodemods();
		await configure(codemods);

		// A container missing the variables must fail at boot, not connect to
		// localhost as root.
		const content = state.files[0]?.content ?? "";
		expect(content).toContain("import env from '#start/env'");
		for (const name of [
			"TDENGINE_URL",
			"TDENGINE_USER",
			"TDENGINE_PASSWORD",
			"TDENGINE_DATABASE",
		]) {
			expect(content).toContain(`env.get('${name}')`);
		}
		expect(content).not.toContain("??");
		expect(content).not.toContain("process.env");
		expect(content).not.toContain("'root'");
	});

	it("declares the variables in start/env.ts when the codemods can", async () => {
		const { state, codemods } = createFakeCodemods();
		const validations: { variables: Record<string, string> }[] = [];
		await configure({
			...codemods,
			async defineEnvValidations(definition) {
				validations.push(definition);
				return Object.keys(definition.variables);
			},
		});

		expect(validations).toHaveLength(1);
		expect(validations[0]?.variables).toEqual({
			TDENGINE_URL: "Env.schema.string()",
			TDENGINE_USER: "Env.schema.string()",
			TDENGINE_PASSWORD: "Env.schema.string.optional()",
			TDENGINE_DATABASE: "Env.schema.string()",
		});
		expect(state.files).toHaveLength(1);
	});
});

describe("eon > /testing stays runner-agnostic", () => {
	it("imports no test runner, so a helix app can use the fake and the factory", async () => {
		const source = await import("node:fs/promises").then((fs) =>
			fs.readFile(new URL("../src/testing/index.ts", import.meta.url), "utf8"),
		);

		// `@c9up/eon/testing` is a SHIPPED export path. A static import of vitest
		// — a devDependency here — made merely importing it require vitest, so an
		// app on helix reaching for `factory` or `FakeEonConnection` would have
		// died on "Cannot find package 'vitest'". Same shape as the comet bug.
		expect(source).not.toMatch(/from ["']vitest["']/);
		expect(source).not.toMatch(/from ["']@c9up\/helix/);
	});

	// Longer than the 5 s default, and only here. This is the one test that
	// pulls the whole `testing` graph through a dynamic import, and under
	// coverage every module in it is instrumented on the way in — enough, on a
	// loaded machine, to cross a timeout the assertion itself is nowhere near.
	// It made the publication gate fail at random on a test that has nothing
	// slow about it, which is worse than the timeout it was protecting against.
	it("still exports the agnostic helpers from that path", {
		timeout: 30_000,
	}, async () => {
		const testing = await import("../src/testing/index.js");
		expect(typeof testing.hasTestServer).toBe("function");
		expect(typeof testing.connectTestEon).toBe("function");
		expect(typeof testing.factory).toBe("function");
		expect(testing.FakeEonConnection).toBeDefined();
	});

	it("declares vitest as an OPTIONAL peer, for the subpath that does need it", async () => {
		const pkg = await import("node:fs/promises")
			.then((fs) =>
				fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
			)
			.then(JSON.parse);

		expect(pkg.peerDependencies?.vitest).toBeDefined();
		expect(pkg.peerDependenciesMeta?.vitest?.optional).toBe(true);
		expect(pkg.exports["./testing/vitest"]).toBeDefined();
	});
});
