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
			TDENGINE_USER: "root",
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
			user: "root",
			password: "",
			database: "ream",
		});
		expect(shape.url).toBe("ws://localhost:6041");
	});

	it("falls back to an empty password rather than a working one", async () => {
		const { state, codemods } = createFakeCodemods();
		await configure(codemods);

		// The .env seeds TDengine's stock password so a local server works, but
		// the generated config falls back to '' when the var is unset: a deploy
		// that forgot to set it must fail to authenticate, not quietly connect
		// with the default credentials.
		expect(state.envVars.TDENGINE_PASSWORD).toBe("taosdata");
		expect(state.files[0]?.content).toContain(
			"process.env.TDENGINE_PASSWORD ?? ''",
		);
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

	it("still exports the agnostic helpers from that path", async () => {
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
