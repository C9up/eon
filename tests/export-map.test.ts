/**
 * The two export maps must agree.
 *
 * `exports` points at `src/*.ts` for workspace development; `publishConfig.exports`
 * points at `dist/*.js` and REPLACES it at `pnpm publish` time. Adding a subpath
 * to the first and forgetting the second ships a package where the subpath does
 * not exist — which is exactly what happened to `./configure`, `./health`,
 * `./schema`, `./tmq` and `./testing/vitest` in 0.2.0: all five were in the repo,
 * none reached npm, and nothing failed until someone ran `ream configure`.
 */
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
	exports: Record<string, string | { types: string; import: string }>;
	publishConfig: {
		exports: Record<string, string | { types: string; import: string }>;
	};
};

describe("export maps", () => {
	it("publishes every subpath development can import", () => {
		const dev = Object.keys(pkg.exports).sort();
		const published = Object.keys(pkg.publishConfig.exports).sort();
		expect(published).toEqual(dev);
	});

	it("every published entry points at the build of its source", () => {
		for (const [key, devValue] of Object.entries(pkg.exports)) {
			const pubValue = pkg.publishConfig.exports[key];
			if (typeof devValue === "string") {
				expect(pubValue).toBe(devValue);
				continue;
			}
			const expected =
				`./dist/${devValue.import.replace(/^\.\/src\//, "").replace(/\.ts$/, ".js")}`;
			expect(pubValue, `subpath ${key}`).toEqual({
				types: expected.replace(/\.js$/, ".d.ts"),
				import: expected,
			});
		}
	});

	it("every source file a subpath names actually exists", () => {
		// A published entry pointing at a file the build never emits fails the
		// same way a missing entry does, one step later.
		for (const [key, devValue] of Object.entries(pkg.exports)) {
			if (typeof devValue === "string") continue;
			const source = new URL(`../${devValue.import.slice(2)}`, import.meta.url);
			expect(existsSync(source), `${key} -> ${devValue.import}`).toBe(true);
		}
	});
});
