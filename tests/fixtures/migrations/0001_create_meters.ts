import { Migration } from "../../../src/index.js";

export default class extends Migration {
	up(): void {
		this.schema.createStable("meters", (t) => {
			t.timestamp("ts");
			t.float("current");
			t.int("groupid").tag();
		});
	}
	down(): void {
		this.schema.dropStable("meters");
	}
}
