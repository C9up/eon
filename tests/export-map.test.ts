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
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type ExportMap = Record<string, string | { types: string; import: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExportMap(value: unknown): value is ExportMap {
	return (
		isRecord(value) &&
		Object.values(value).every(
			(entry) =>
				typeof entry === "string" ||
				(isRecord(entry) &&
					typeof entry.types === "string" &&
					typeof entry.import === "string"),
		)
	);
}

function readPackage(): {
	exports: ExportMap;
	publishConfig: { exports: ExportMap };
} {
	const parsed: unknown = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	);
	if (!isRecord(parsed) || !isRecord(parsed.publishConfig)) {
		throw new Error("package.json has no publishConfig");
	}
	const { exports } = parsed;
	const published = parsed.publishConfig.exports;
	if (!isExportMap(exports) || !isExportMap(published)) {
		throw new Error("package.json export maps are not path maps");
	}
	return { exports, publishConfig: { exports: published } };
}

const pkg = readPackage();

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
			const expected = `./dist/${devValue.import.replace(/^\.\/src\//, "").replace(/\.ts$/, ".js")}`;
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

describe("package files", () => {
	it("ships the licence text the manifest declares", () => {
		// `files` lists LICENSE and `license` says MIT: without the file the
		// tarball carries no licence text at all, and npm packs without a word.
		const manifest: unknown = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		);
		expect(isRecord(manifest) && manifest.license).toBe("MIT");
		expect(isRecord(manifest) && manifest.files).toContain("LICENSE");
		const licence = new URL("../LICENSE", import.meta.url);
		expect(existsSync(licence)).toBe(true);
		// A Windows checkout may turn the line endings into CRLF.
		expect(readFileSync(licence, "utf8")).toMatch(/^MIT License\r?\n/);
	});
});
