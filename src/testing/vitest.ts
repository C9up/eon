/**
 * The vitest-flavoured half of eon's test helpers.
 *
 * Split out on purpose. `@c9up/eon/testing` is a SHIPPED export path, and a
 * static `import { describe } from "vitest"` made merely importing it require
 * vitest — which eon carries as a devDependency only. An app on helix (ream's
 * own runner) reaching for `factory` or `FakeEonConnection` would have died on
 * `Cannot find package 'vitest'`, the same shape as the @c9up/comet bug.
 *
 * Everything runner-agnostic stays in `./index.ts`. Only this file needs the
 * runner, and vitest is declared an OPTIONAL peer for it.
 */
import { describe } from "vitest";
import { hasTestServer } from "./index.js";

/**
 * Register a suite that runs only when a test server is configured, else skips —
 * so integration suites gate uniformly. CI (with `EON_TEST_URL`) runs them for
 * real; local dev without a server skips them.
 */
export function describeIfTdengine(name: string, factory: () => void): void {
	if (hasTestServer()) {
		describe(name, factory);
	} else {
		describe.skip(name, factory);
	}
}
