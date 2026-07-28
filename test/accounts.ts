/**
 * Account fixtures built from the in-code allowlist itself (src/allowlist.ts),
 * shared so both suites derive them the same way. An entry whose id or login
 * changes must not silently turn a trusted fixture into an ordinary account —
 * that would reduce every §3.1 case to an author-not-trusted skip while the
 * assertions still pass. The near-miss fixtures are stated as the allowlisted
 * account with exactly one field overridden, so they stay near-misses too.
 */

import { ALLOWED_BOTS, WEB_FLOW } from "../src/allowlist";
import type { GithubAccount } from "../src/types";

interface AccountOverrides {
	readonly id?: number;
	readonly login?: string;
	readonly type?: string;
}

/** The allowlisted bot for a login, optionally with one field replaced to break the match. */
export function allowedBot(login: string, overrides: AccountOverrides = {}): GithubAccount {
	const bot = ALLOWED_BOTS.find((entry) => entry.login === login);
	if (bot === undefined) {
		throw new Error(`not an allowlisted bot: ${login}`);
	}
	return {
		id: overrides.id ?? bot.id,
		login: overrides.login ?? bot.login,
		type: overrides.type ?? "Bot",
	};
}

/** The allowlisted bots both suites drive the §3.1 cases with. */
export const RENOVATE: GithubAccount = allowedBot("renovate[bot]");
export const AUTOFIX_CI: GithubAccount = allowedBot("autofix-ci[bot]");
/** The allowlisted renovate login under a different account (SPEC.md §3.1 id pinning). */
export const RENOVATE_WRONG_ID: GithubAccount = allowedBot("renovate[bot]", { id: 2 });

/** The web-flow committer (SPEC.md §3.2); GitHub attributes it as a User, not a Bot. */
export const WEB_FLOW_USER: GithubAccount = {
	id: WEB_FLOW.id,
	login: WEB_FLOW.login,
	type: "User",
};

/** Same login, different account: the committer exemption must not fire on the login alone. */
export const WEB_FLOW_LOOKALIKE: GithubAccount = { id: 999, login: WEB_FLOW.login, type: "User" };
