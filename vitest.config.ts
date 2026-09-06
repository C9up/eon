import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
			// `src/vendor/**` is generated from scripts/vendor/ and identical in every
			// package that carries it, so measuring it here counts the same lines N
			// times and holds this package to a floor for code it cannot change. The
			// behaviour is pinned where it broke: bay's quasar-bridge suite covers the
			// two manager shapes the loader has to accept.
		exclude: ["**/node_modules/**", "**/dist/**"],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts", "src/vendor/**"],
			reporter: ["text-summary", "json-summary"],
			// A floor, not a target: set just under what the suite covers today, so
			// a change that stops testing a path fails here instead of landing.
			thresholds: {
				lines: 74,
				statements: 72,
				branches: 62,
				functions: 74,
			},
		},
	},
});
