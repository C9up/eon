import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: ["**/node_modules/**", "**/dist/**"],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			exclude: ["src/**/*.d.ts"],
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
