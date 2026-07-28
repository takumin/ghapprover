/**
 * In-code approval constants (SPEC.md §5). There is deliberately no runtime
 * configuration: changing the allowlist means editing this file and
 * redeploying, so the approval conditions are always version-controlled.
 */

/** A GitHub account pinned by both login and numeric id (SPEC.md §3.1, §3.2). */
export interface AccountRef {
	readonly login: string;
	readonly id: number;
}

/**
 * Bot accounts trusted as PR authors and commit authors/committers
 * (SPEC.md §3.1). The numeric id must match alongside the login as defense in
 * depth against lookalike logins. The entries are the Mend-hosted Renovate app,
 * GitHub-native Dependabot, and the autofix.ci app; self-hosted lookalikes run
 * under different logins/ids and are rejected by design.
 */
export const ALLOWED_BOTS: readonly AccountRef[] = [
	{ id: 29_139_614, login: "renovate[bot]" },
	{ id: 49_699_333, login: "dependabot[bot]" },
	{ id: 114_827_586, login: "autofix-ci[bot]" },
];

/**
 * The account GitHub attributes as committer to commits it creates itself (web
 * UI or API). Accepted as committer only; genuine web-flow commits are always
 * GitHub-signed, which the verification check enforces (SPEC.md §3.2). The
 * numeric id is pinned alongside the login for the same reason as ALLOWED_BOTS:
 * this exemption decides approval, so it must not turn on a login string alone.
 */
export const WEB_FLOW: AccountRef = { id: 19_864_447, login: "web-flow" };

/**
 * The PR commits API returns at most 250 commits, so a PR declaring more can
 * never be fully verified and is not approved (SPEC.md §3.2).
 */
export const MAX_VERIFIABLE_COMMITS = 250;
