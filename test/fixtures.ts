/**
 * The subject every suite shares: the accounts, the repository built around one of them, and the
 * pull request of that repository. Named for what it holds rather than for the accounts alone,
 * because a repository and its pull request are not accounts and every suite means the same one by
 * them — the unit suites that build a pull request to decide on, and the delivery suites that serve
 * its API calls (test/github-api.ts), all read them from here.
 *
 * The allowlisted accounts are built from the in-code allowlist itself (src/account.ts) so every
 * suite derives them the same way: an entry whose id or login changes must not silently turn a
 * trusted fixture into an ordinary account — that would reduce every §3.1 case to an
 * author-not-trusted skip while the assertions still pass. The near-miss fixtures are stated as the
 * allowlisted account with exactly one field overridden, so they stay near-misses too. The plain
 * accounts at the bottom carry no standing of their own and are here only because more than one
 * suite builds a payload around them.
 */

import { ALLOWED_BOTS, WEB_FLOW } from "~src/account";
import type { EventRepository, GithubAccount } from "~src/types";

interface AccountOverrides {
	readonly id?: number;
	readonly login?: string;
	readonly type?: string;
}

/** The allowlisted bot for a login, optionally with one field replaced to break the match. */
function allowedBot(login: string, overrides: AccountOverrides = {}): GithubAccount {
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
const RENOVATE: GithubAccount = allowedBot("renovate[bot]");
const AUTOFIX_CI: GithubAccount = allowedBot("autofix-ci[bot]");
/** The allowlisted renovate login under a different account (SPEC.md §3.1 id pinning). */
const RENOVATE_WRONG_ID: GithubAccount = allowedBot("renovate[bot]", { id: 2 });

/** The web-flow committer (SPEC.md §3.2); GitHub attributes it as a User, not a Bot. */
const WEB_FLOW_USER: GithubAccount = {
	id: WEB_FLOW.id,
	login: WEB_FLOW.login,
	type: "User",
};

/** Same login, different account: the committer exemption must not fire on the login alone. */
const WEB_FLOW_LOOKALIKE: GithubAccount = { id: 999, login: WEB_FLOW.login, type: "User" };

/** The slug GET /app answers with (test/github-api.ts), and the App's own bot login below. */
const APP_SLUG = "ghapprover";
/**
 * The App's own bot user (SPEC.md §3 cond. 5): the login GET /app derives from the slug above,
 * derived here the same way rather than spelled out, so the account the suites match reviews
 * against cannot disagree with the response the route serves. Stated once because both the unit
 * suite that drives hasOwnApproval and the delivery suites that serve its own approval as a review
 * have to mean the same account by it.
 */
const APP_BOT: GithubAccount = { id: 201, login: `${APP_SLUG}[bot]`, type: "Bot" };

/**
 * The owner of the fixture repository below: the delivery suites approve its pull request, the
 * endpoint suites serve it as a commit and review author, and the §3.1 cases decide on it as the
 * personal-repository owner, so all of them must mean one account by it.
 */
const OWNER: GithubAccount = { id: 7, login: "octo", type: "User" };
const REPO_NAME = "hello";
/**
 * The one repository every suite is about, as an event payload carries it, stated with its owner
 * rather than beside it — under the owner a case gives it, because a repository owned by an
 * organization is what sends §3.1 through the membership API. The suite that drives the payload
 * schema (payload.test.ts), the one that drives the §3 conditions evaluated against it
 * (decision.test.ts) and the delivery suites that serve its API calls (test/github-api.ts) all build
 * it here: a second declaration can disagree about the modeled repository and both still pass.
 */
function repositoryOwnedBy(owner: GithubAccount = OWNER): EventRepository {
	return { full_name: `${owner.login}/${REPO_NAME}`, id: 555, name: REPO_NAME, owner };
}
const REPOSITORY: EventRepository = repositoryOwnedBy();
/**
 * The pull request of that repository: the number its routes are addressed by, and the head commit
 * its payload declares. Stated once with the repository it belongs to, because "the head" has to
 * mean one commit across the suite that decides on it, the one that logs it, and the routes served
 * for it — a sha spelled per suite is one that can be corrected in whichever suite failed.
 */
const PULL_NUMBER = 5;
const HEAD_SHA = "head-sha";
/**
 * The organization every §3.1 org-branch case is owned by: the unit suite that drives
 * classifyPrincipal and the delivery suites that serve the membership lookup it defers to have to
 * mean the same account by it, and the membership URL those routes are planned on is built from
 * this login rather than repeating it.
 */
const ORG: GithubAccount = { id: 88, login: "acme", type: "Organization" };
/** An ordinary user: not allowlisted, not an owner, and not the App's own bot. */
const HUMAN: GithubAccount = { id: 301, login: "human", type: "User" };

export {
	APP_BOT,
	APP_SLUG,
	AUTOFIX_CI,
	HEAD_SHA,
	HUMAN,
	ORG,
	OWNER,
	PULL_NUMBER,
	RENOVATE,
	RENOVATE_WRONG_ID,
	REPOSITORY,
	WEB_FLOW_LOOKALIKE,
	WEB_FLOW_USER,
	allowedBot,
	repositoryOwnedBy,
};
