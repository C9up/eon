import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("README", () => {
	it("describes the shapes without naming the framework products they follow", () => {
		const readme = readFileSync(
			new URL("../README.md", import.meta.url),
			"utf8",
		);
		expect(readme).not.toMatch(/adonis|lucid|japa/i);
	});
});
