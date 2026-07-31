/**
 * The identity every SPEC.md §3 approval decision is made against, and the in-code accounts §3
 * exempts by it (§5). The (id, login) pair is the whole of what an account is here — every trust
 * check, every exemption and every per-delivery cache key asks that one question — so the pair and
 * the two exemptions matched on it are stated in this module and read from it everywhere else.
 * There is deliberately no runtime configuration: changing the allowlist means editing this file
 * and redeploying, so the approval conditions are always version-controlled.
 */

/* A GitHub account pinned by both login and numeric id (SPEC.md §3.1, §3.2). The parameter type of
 * every predicate below, and the shape of the two constants — callers pass the payload's own account
 * (src/types.ts), which is why this is not exported. */
interface AccountRef {
	readonly login: string;
	readonly id: number;
}

/* The identity every §3 trust decision is made against: the (id, login) pair, never the login
 * alone. Every identity comparison goes through this key or through isSameAccount below, and
 * callers that cache principals key on it too — an account reusing a trusted login would otherwise
 * inherit that trust and defeat the id pinning. Injective, because a numeric id cannot contain the
 * separator. */
function accountKey(account: AccountRef): string {
	return `${account.id}:${account.login}`;
}
/** The same account: the key comparison above, so no caller spells that comparison out itself. */
function isSameAccount(one: AccountRef, other: AccountRef): boolean {
	return accountKey(one) === accountKey(other);
}

/**
 * Bot accounts trusted as PR authors and commit authors/committers
 * (SPEC.md §3.1). The numeric id must match alongside the login as defense in
 * depth against lookalike logins. The entries are the Mend-hosted Renovate app,
 * GitHub-native Dependabot, and the autofix.ci app; self-hosted lookalikes run
 * under different logins/ids and are rejected by design.
 */
const ALLOWED_BOTS: readonly AccountRef[] = [
	{ id: 29_139_614, login: "renovate[bot]" },
	{ id: 49_699_333, login: "dependabot[bot]" },
	{ id: 114_827_586, login: "autofix-ci[bot]" },
];

/**
 * The account GitHub attributes as committer to commits it creates itself (web
 * UI or API). Accepted as committer only, which is the commit condition's own rule
 * (src/commits.ts); genuine web-flow commits are always GitHub-signed, which the verification
 * check enforces (SPEC.md §3.2).
 */
const WEB_FLOW: AccountRef = { id: 19_864_447, login: "web-flow" };

/* The allowlist as the keys it is compared against, derived once at module scope: it is an in-code
 * constant (SPEC.md §5) and is compared against on every delivery, so deriving it per call is work
 * every delivery repeats for nothing. */
const ALLOWED_BOT_KEYS: ReadonlySet<string> = new Set(ALLOWED_BOTS.map((bot) => accountKey(bot)));

/** SPEC.md §3.1: on the allowlist, matched as the pair — the same login under another id is not. */
function isAllowedBot(account: AccountRef): boolean {
	return ALLOWED_BOT_KEYS.has(accountKey(account));
}
/** SPEC.md §3.2: the web-flow account itself, matched as the pair for the same reason. */
function isWebFlow(account: AccountRef): boolean {
	return isSameAccount(account, WEB_FLOW);
}

export { ALLOWED_BOTS, WEB_FLOW, accountKey, isAllowedBot, isSameAccount, isWebFlow };
