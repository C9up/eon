import { describe, expect, it } from "vitest";
import { defineColumn } from "../src/connection/row.js";

describe("eon > defineColumn", () => {
	it("keeps a __proto__ column holding an object as an own key, prototype untouched", () => {
		const row: Record<string, unknown> = {};
		const payload = new ArrayBuffer(2);
		defineColumn(row, "__proto__", payload);
		defineColumn(row, "constructor", 2n);

		expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
		expect(Object.keys(row)).toEqual(["__proto__", "constructor"]);
		expect(Object.getOwnPropertyDescriptor(row, "__proto__")?.value).toBe(
			payload,
		);
		expect(Object.getOwnPropertyDescriptor(row, "constructor")?.value).toBe(2n);
	});

	it("leaves the column writable and enumerable like an assigned one", () => {
		const row: Record<string, unknown> = {};
		defineColumn(row, "current", 10.5);
		row.current = 11.5;
		expect(row).toEqual({ current: 11.5 });
		expect(JSON.stringify(row)).toBe('{"current":11.5}');
	});
});
