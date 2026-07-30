/**
 * Account fixtures shared across the suites, and the repository fixture built around one of them.
 * The allowlisted accounts are built from the in-code allowlist itself (src/account.ts) so every
 * suite derives them the same way: an entry whose id
 * or login changes must not silently turn a trusted fixture into an ordinary account — that would
 * reduce every §3.1 case to an author-not-trusted skip while the assertions still pass. The
 * near-miss fixtures are stated as the allowlisted account with exactly one field overridden, so
 * they stay near-misses too. The plain accounts at the bottom carry no standing of their own and
 * are here only because more than one suite builds a payload around them.
 */

import { ALLOWED_BOTS, WEB_FLOW } from "../src/account";
import type { EventRepository, GithubAccount } from "../src/types";

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

/**
 * The App's own bot user (SPEC.md §3 cond. 5): the login GET /app derives from the "ghapprover"
 * slug the route fixtures serve. Stated once because both the unit suite that drives
 * hasOwnApproval and the delivery suites that serve its own approval as a review have to mean the
 * same account by it — two declarations could disagree and both still pass.
 */
export const APP_BOT: GithubAccount = { id: 201, login: "ghapprover[bot]", type: "Bot" };

/** The repository owner the payload fixtures are built around. */
export const OCTOCAT: GithubAccount = { id: 77, login: "octocat", type: "User" };
/**
 * The repository those fixtures are for, stated with its owner rather than beside it: the suite
 * that drives the payload schema (payload.test.ts) and the one that drives the §3 conditions
 * evaluated against it (decision.test.ts) both build it, so a field the schema gains has to reach
 * both — two declarations can disagree about the modeled repository and both still pass.
 */
export const WIDGETS_REPO: EventRepository = {
	full_name: `${OCTOCAT.login}/widgets`,
	id: 555,
	name: "widgets",
	owner: OCTOCAT,
};
/**
 * The owner of the `octo/hello` fixture repository both route-helper families build their calls
 * against (delivery.ts, github-routes.ts): the delivery suites approve its pull request and the
 * endpoint suites serve it as a commit and review author, so the two must mean one account by it.
 */
export const OCTO: GithubAccount = { id: 7, login: "octo", type: "User" };
/**
 * The organization every §3.1 org-branch case is owned by: the unit suite that drives
 * classifyPrincipal and the delivery suites that serve the membership lookup it defers to have to
 * mean the same account by it, and the membership URL those routes are planned on is built from
 * this login rather than repeating it.
 */
export const ORG: GithubAccount = { id: 88, login: "acme", type: "Organization" };
/** An ordinary user: not allowlisted, not an owner, and not the App's own bot. */
export const HUMAN: GithubAccount = { id: 301, login: "human", type: "User" };
