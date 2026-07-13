import { Migration } from "../../../src/index.js";

export default class extends Migration {
	up(): void {
		this.schema.alterStable("meters", (t) => {
			t.addColumn("voltage").int();
		});
	}
	down(): void {
		this.schema.alterStable("meters", (t) => {
			t.dropColumn("voltage");
		});
	}
}
