/**
 * A connection URL fit for an error message. The connector accepts credentials
 * in the URL (`ws://user:pass@host`, `?token=`, `?bearer_token=`) and masks them
 * in its own messages; eon's added context has to do the same. Every query
 * value is masked, not only the names known today: taosAdapter's query string
 * carries auth, and an unknown key is safer hidden.
 */
export function redactUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// Nothing of it can be shown safely: the credentials are somewhere in it.
		return "<unparseable URL>";
	}
	if (parsed.password !== "") parsed.password = "***";
	for (const key of new Set(parsed.searchParams.keys())) {
		parsed.searchParams.set(key, "***");
	}
	return parsed.toString();
}
