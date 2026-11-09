import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Where `tsx` lives. It is a devDependency of this package, so in a standalone
 * checkout (what CI runs) it sits in the package's own node_modules; in the
 * monorepo pnpm hoists it to the workspace root instead. Looking only at the
 * root made a child-process test spawn a binary that does not exist in CI — the
 * child never started, never exited, and the test read that as "the process
 * hung".
 */
export function tsxBinary(): string {
	const candidates = [
		path.join(packageRoot, "node_modules", ".bin", "tsx"),
		path.join(packageRoot, "..", "..", "node_modules", ".bin", "tsx"),
	];
	const found = candidates.find((c) => existsSync(c));
	if (found === undefined) {
		throw new Error(`tsx not found — looked in:\n  ${candidates.join("\n  ")}`);
	}
	return found;
}
