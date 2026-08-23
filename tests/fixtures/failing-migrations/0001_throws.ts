import { Migration } from "../../../src/index.js";

/** Blows up during `up()` — used to prove the lock is released on failure. */
export default class extends Migration {
	up(): void {
		throw new Error("boom");
	}
	down(): void {}
}
