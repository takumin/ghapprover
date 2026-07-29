/* A deliberately exhaustive case matrix for every decision function (SPEC.md §12),
 * which does not fit the default file length budget. */
/* oxlint-disable max-lines */

import {
	AUTOFIX_CI,
	RENOVATE,
	RENOVATE_WRONG_ID,
	WEB_FLOW_LOOKALIKE,
	WEB_FLOW_USER,
	allowedBot,
} from "./accounts";
import type {
	EventPullRequest,
	EventRepository,
	GithubAccount,
	LivePullRequest,
	OrgMembership,
	PullRequestCommit,
	PullRequestEventPayload,
	PullRequestReview,
} from "../src/types";
import {
	accountKey,
	checkCommit,
	checkCommitCount,
	checkPullRequestState,
	classifyPrincipal,
	commitPrincipals,
	hasOwnApproval,
	isLiveStateCurrent,
	isOwnerMembership,
	isTargetAction,
	parsePullRequestEvent,
	precheckCommitCount,
} from "../src/decision";
import { describe, expect, it } from "vitest";
import { MAX_VERIFIABLE_COMMITS } from "../src/allowlist";

const HEAD_SHA = "head-sha";
const BOT_LOGIN = "ghapprover[bot]";
const OCTOCAT: GithubAccount = { id: 77, login: "octocat", type: "User" };
/** The owner's login under a different account: §3.1 pins the personal-repo owner's id too. */
const OCTOCAT_WRONG_ID: GithubAccount = { id: 78, login: "octocat", type: "User" };
const OTHER_USER: GithubAccount = { id: 55, login: "someone-else", type: "User" };
const ORG_OWNER: GithubAccount = { id: 88, login: "acme", type: "Organization" };
const DEPENDABOT = allowedBot("dependabot[bot]");
/** Deliberately not on the allowlist: a bot GitHub ships, which §3.1 still rejects. */
const GITHUB_ACTIONS: GithubAccount = { id: 41_898_282, login: "github-actions[bot]", type: "Bot" };
const AUTOFIX_CI_WRONG_ID = allowedBot("autofix-ci[bot]", { id: 3 });
const RENOVATE_WRONG_LOGIN = allowedBot("renovate[bot]", { login: "renovate-bot" });
const RENOVATE_TYPE_USER = allowedBot("renovate[bot]", { type: "User" });
const BOT_NAMED_OCTOCAT: GithubAccount = { id: 5, login: "octocat", type: "Bot" };
const ALICE: GithubAccount = { id: 101, login: "alice", type: "User" };
const BOB: GithubAccount = { id: 102, login: "bob", type: "User" };
const MALLORY: GithubAccount = { id: 103, login: "mallory", type: "User" };
/** Same login as a trusted user, different account: trust must not follow the login. */
const ALICE_LOOKALIKE: GithubAccount = { id: 909, login: "alice", type: "User" };
const HUMAN: GithubAccount = { id: 301, login: "human", type: "User" };
const APP_BOT: GithubAccount = { id: 201, login: BOT_LOGIN, type: "Bot" };
const ACTIVE_ADMIN: OrgMembership = { role: "admin", state: "active" };
const ACTIVE_MEMBER: OrgMembership = { role: "member", state: "active" };
const PENDING_ADMIN: OrgMembership = { role: "admin", state: "pending" };
const TRUSTED_ACCOUNTS: ReadonlySet<string> = new Set([accountKey(ALICE), accountKey(BOB)]);

/** Stands in for the pipeline's membership lookup, which is why the predicate is async. */
async function isTrustedFixture(account: GithubAccount): Promise<boolean> {
	return TRUSTED_ACCOUNTS.has(accountKey(account));
}

interface PrStateOverrides {
	readonly draft?: boolean;
	readonly repo?: { readonly id: number } | null;
	readonly state?: string;
}

/** The base repository every PR-state fixture is evaluated against; head repo 555 is not a fork. */
const BASE_REPO: EventRepository = {
	full_name: "octocat/widgets",
	id: 555,
	name: "widgets",
	owner: OCTOCAT,
};

function eventPullRequest(overrides: PrStateOverrides = {}): EventPullRequest {
	const { draft = false, repo = { id: 555 }, state = "open" } = overrides;
	return { commits: 1, draft, head: { repo, sha: HEAD_SHA }, number: 11, state, user: OCTOCAT };
}

interface CommitOverrides {
	readonly author?: GithubAccount | null;
	readonly committer?: GithubAccount | null;
	readonly verification?: { readonly verified: boolean } | null;
}

function commit(overrides: CommitOverrides = {}): PullRequestCommit {
	const { author = ALICE, committer = ALICE, verification = { verified: true } } = overrides;
	return { author, commit: { verification }, committer, sha: "commit-sha" };
}

interface ReviewOverrides {
	readonly commit_id?: string | null;
	readonly state?: string;
	readonly user?: GithubAccount | null;
}

function review(overrides: ReviewOverrides = {}): PullRequestReview {
	const { commit_id: commitId = HEAD_SHA, state = "APPROVED", user = APP_BOT } = overrides;
	return { commit_id: commitId, state, user };
}

interface LiveOverrides {
	readonly draft?: boolean;
	readonly sha?: string;
	readonly state?: string;
}

function livePullRequest(overrides: LiveOverrides = {}): LivePullRequest {
	const { draft = false, sha = HEAD_SHA, state = "open" } = overrides;
	return { draft, head: { sha }, state };
}

function expectedPayload(): PullRequestEventPayload {
	return {
		action: "opened",
		installation: { id: 12_345 },
		pull_request: {
			commits: 3,
			draft: false,
			head: { repo: { id: 555 }, sha: HEAD_SHA },
			number: 42,
			state: "open",
			user: OCTOCAT,
		},
		repository: { full_name: "octocat/widgets", id: 555, name: "widgets", owner: OCTOCAT },
	};
}

function merged(base: object, overrides: Record<string, unknown>): Record<string, unknown> {
	const target: Record<string, unknown> = {};
	return Object.assign(target, base, overrides);
}

function pr(pullRequestOverrides: Record<string, unknown>): Record<string, unknown> {
	const base = expectedPayload();
	return merged(base, { pull_request: merged(base.pull_request, pullRequestOverrides) });
}

const CLASSIFY_CASES = [
	{
		expected: { kind: "trusted" },
		name: "the personal repository owner",
		owner: OCTOCAT,
		user: OCTOCAT,
	},
	{
		expected: { kind: "untrusted" },
		name: "another user on a personal repository",
		owner: OCTOCAT,
		user: OTHER_USER,
	},
	{
		expected: { kind: "untrusted" },
		name: "a user with the owner's login but another id",
		owner: OCTOCAT,
		user: OCTOCAT_WRONG_ID,
	},
	{
		expected: { kind: "org-membership", login: "octocat", org: "acme" },
		name: "a user on an org repository",
		owner: ORG_OWNER,
		user: OCTOCAT,
	},
	{
		expected: { kind: "trusted" },
		name: "renovate with the exact login and id",
		owner: OCTOCAT,
		user: RENOVATE,
	},
	{
		expected: { kind: "trusted" },
		name: "dependabot on an org repository",
		owner: ORG_OWNER,
		user: DEPENDABOT,
	},
	{
		expected: { kind: "trusted" },
		name: "autofix-ci with the exact login and id",
		owner: OCTOCAT,
		user: AUTOFIX_CI,
	},
	{
		expected: { kind: "untrusted" },
		name: "a bot with the autofix-ci login but another id",
		owner: OCTOCAT,
		user: AUTOFIX_CI_WRONG_ID,
	},
	{
		expected: { kind: "untrusted" },
		name: "a bot with the renovate login but another id",
		owner: OCTOCAT,
		user: RENOVATE_WRONG_ID,
	},
	{
		expected: { kind: "untrusted" },
		name: "a bot with the renovate id but another login",
		owner: OCTOCAT,
		user: RENOVATE_WRONG_LOGIN,
	},
	{
		expected: { kind: "untrusted" },
		name: "github-actions even on an org repository",
		owner: ORG_OWNER,
		user: GITHUB_ACTIONS,
	},
	{
		expected: { kind: "untrusted" },
		name: "a bot named like the personal owner",
		owner: OCTOCAT,
		user: BOT_NAMED_OCTOCAT,
	},
	{
		expected: { kind: "org-membership", login: "renovate[bot]", org: "acme" },
		name: "a User named like renovate on an org repository",
		owner: ORG_OWNER,
		user: RENOVATE_TYPE_USER,
	},
	{
		expected: { kind: "untrusted" },
		name: "a User named like renovate on a personal repository",
		owner: OCTOCAT,
		user: RENOVATE_TYPE_USER,
	},
];

interface CommitCase {
	readonly entry: PullRequestCommit;
	readonly expected: string | null;
	readonly name: string;
}

const COMMIT_CASES: readonly CommitCase[] = [
	{ entry: commit(), expected: null, name: "a verified trusted commit" },
	{
		entry: commit({ author: BOB, committer: BOB }),
		expected: null,
		name: "the author doubling as committer",
	},
	{ entry: commit({ committer: WEB_FLOW_USER }), expected: null, name: "a web-flow committer" },
	{
		entry: commit({ committer: WEB_FLOW_LOOKALIKE }),
		expected: "untrusted-commit",
		name: "a web-flow lookalike committer with a different id",
	},
	{
		entry: commit({ verification: { verified: false } }),
		expected: "unverified-commit",
		name: "a failed verification",
	},
	{
		entry: commit({ verification: null }),
		expected: "unverified-commit",
		name: "missing verification data",
	},
	{ entry: commit({ author: null }), expected: "untrusted-commit", name: "an unmapped author" },
	{
		entry: commit({ author: MALLORY }),
		expected: "untrusted-commit",
		name: "an untrusted author",
	},
	{
		entry: commit({ author: WEB_FLOW_USER }),
		expected: "untrusted-commit",
		name: "a web-flow author",
	},
	{
		entry: commit({ committer: null }),
		expected: "untrusted-commit",
		name: "an unmapped committer",
	},
	{
		entry: commit({ committer: MALLORY }),
		expected: "untrusted-commit",
		name: "an untrusted committer",
	},
	{
		entry: commit({ author: MALLORY, verification: null }),
		expected: "unverified-commit",
		name: "unverified before untrusted on one commit",
	},
	{
		entry: commit({ author: ALICE_LOOKALIKE, committer: ALICE_LOOKALIKE }),
		expected: "untrusted-commit",
		name: "an author reusing a trusted login under another id",
	},
	{
		entry: commit({ author: ALICE, committer: ALICE_LOOKALIKE }),
		expected: "untrusted-commit",
		name: "a committer reusing the author's login under another id",
	},
];

interface CommitCountCase {
	readonly declared: number;
	readonly expected: string | null;
	readonly fetched: number;
}

const COMMIT_COUNT_CASES: readonly CommitCountCase[] = [
	{ declared: 2, expected: "commit-count-mismatch", fetched: 1 },
	{ declared: 1, expected: "commit-count-mismatch", fetched: 2 },
	{ declared: 2, expected: null, fetched: 2 },
];

const WITHOUT_INSTALLATION = {
	action: "opened",
	pull_request: expectedPayload().pull_request,
	repository: expectedPayload().repository,
};
const NO_INSTALLATION = merged(expectedPayload(), { installation: null });
const NULL_HEAD_REPO = pr({ head: { repo: null, sha: HEAD_SHA } });

const PARSE_OK_CASES = [
	{ expected: expectedPayload(), name: "a fully populated payload", payload: expectedPayload() },
	{
		expected: expectedPayload(),
		name: "extra unmodeled fields",
		payload: merged(expectedPayload(), { sender: HUMAN }),
	},
	{ expected: NO_INSTALLATION, name: "installation absent", payload: WITHOUT_INSTALLATION },
	{
		expected: NO_INSTALLATION,
		name: "installation id not numeric",
		payload: merged(expectedPayload(), { installation: { id: "12" } }),
	},
	{
		expected: NO_INSTALLATION,
		name: "installation not an object",
		payload: merged(expectedPayload(), { installation: "x" }),
	},
	{ expected: NULL_HEAD_REPO, name: "head repo null", payload: NULL_HEAD_REPO },
	{ expected: NULL_HEAD_REPO, name: "head repo absent", payload: pr({ head: { sha: HEAD_SHA } }) },
];

const MALFORMED_PAYLOADS = [
	{ name: "payload not an object", payload: "not-an-object" },
	{ name: "payload null", payload: null },
	{ name: "payload an array", payload: [expectedPayload()] },
	{
		name: "action missing",
		payload: {
			pull_request: expectedPayload().pull_request,
			repository: expectedPayload().repository,
		},
	},
	{ name: "action not a string", payload: merged(expectedPayload(), { action: 404 }) },
	{
		name: "pull_request missing",
		payload: { action: "opened", repository: expectedPayload().repository },
	},
	{
		name: "pull_request not an object",
		payload: merged(expectedPayload(), { pull_request: "pr" }),
	},
	{ name: "number not a number", payload: pr({ number: "42" }) },
	{ name: "commits not a number", payload: pr({ commits: "3" }) },
	{ name: "draft not a boolean", payload: pr({ draft: "false" }) },
	{ name: "state not a string", payload: pr({ state: 7 }) },
	{ name: "user not an object", payload: pr({ user: "octocat" }) },
	{ name: "user id not numeric", payload: pr({ user: { id: "1", login: "o", type: "User" } }) },
	{ name: "head not an object", payload: pr({ head: "deadbeef" }) },
	{ name: "head sha missing", payload: pr({ head: { repo: { id: 555 } } }) },
	{ name: "head repo not an object", payload: pr({ head: { repo: "x", sha: HEAD_SHA } }) },
	{ name: "head repo id not numeric", payload: pr({ head: { repo: { id: "5" }, sha: HEAD_SHA } }) },
	{
		name: "repository missing",
		payload: { action: "opened", pull_request: expectedPayload().pull_request },
	},
	{
		name: "repository owner id missing",
		payload: merged(expectedPayload(), {
			repository: { full_name: "o/w", id: 555, name: "w", owner: { login: "o", type: "User" } },
		}),
	},
	{
		name: "full_name not a string",
		payload: merged(expectedPayload(), {
			repository: { full_name: 7, id: 555, name: "w", owner: OCTOCAT },
		}),
	},
	{
		name: "repository id missing",
		payload: merged(expectedPayload(), {
			repository: { full_name: "o/w", name: "w", owner: OCTOCAT },
		}),
	},
];

describe("target action filtering", () => {
	it.each([
		{ action: "opened", expected: true },
		{ action: "reopened", expected: true },
		{ action: "synchronize", expected: true },
		{ action: "ready_for_review", expected: true },
		{ action: "closed", expected: false },
		{ action: "edited", expected: false },
		{ action: "labeled", expected: false },
		{ action: "converted_to_draft", expected: false },
		{ action: "review_requested", expected: false },
	])("returns $expected for $action", ({ action, expected }) => {
		expect.hasAssertions();
		expect(isTargetAction(action)).toBe(expected);
	});
});

describe("pull request state gate", () => {
	it.each([
		{ expected: null, name: "an open non-draft pull request", overrides: {} },
		{ expected: "pr-not-open", name: "a closed pull request", overrides: { state: "closed" } },
		{ expected: "pr-draft", name: "a draft pull request", overrides: { draft: true } },
		{ expected: "head-repo-missing", name: "a deleted head repo", overrides: { repo: null } },
		{
			expected: "head-repo-forked",
			name: "a head repo other than the base repo",
			overrides: { repo: { id: 999 } },
		},
		{
			expected: "pr-not-open",
			name: "a closed draft without head repo",
			overrides: { draft: true, repo: null, state: "closed" },
		},
		{
			expected: "pr-draft",
			name: "an open draft without head repo",
			overrides: { draft: true, repo: null },
		},
		{
			expected: "pr-draft",
			name: "a draft fork pull request",
			overrides: { draft: true, repo: { id: 999 } },
		},
	])("returns $expected for $name", ({ expected, overrides }) => {
		expect.hasAssertions();
		expect(checkPullRequestState(eventPullRequest(overrides), BASE_REPO)).toBe(expected);
	});
});

describe("principal classification", () => {
	it.each(CLASSIFY_CASES)("classifies $name as $expected.kind", ({ expected, owner, user }) => {
		expect.hasAssertions();
		expect(classifyPrincipal(user, owner)).toStrictEqual(expected);
	});
});

describe("org owner membership", () => {
	it.each([
		{ expected: true, membership: ACTIVE_ADMIN, name: "an active admin" },
		{ expected: false, membership: ACTIVE_MEMBER, name: "an active regular member" },
		{ expected: false, membership: PENDING_ADMIN, name: "a pending admin" },
		{ expected: false, membership: null, name: "a missing membership (404)" },
	])("returns $expected for $name", ({ expected, membership }) => {
		expect.hasAssertions();
		expect(isOwnerMembership(membership)).toBe(expected);
	});
});

describe("commit principal collection", () => {
	it.each([
		{
			entry: commit({ author: ALICE, committer: BOB }),
			expected: [ALICE, BOB],
			name: "a distinct author and committer",
		},
		{
			entry: commit({ author: BOB, committer: BOB }),
			expected: [BOB],
			name: "the author once when the committer repeats it",
		},
		{
			entry: commit({ author: null, committer: null }),
			expected: [],
			name: "nothing from unmapped author and committer",
		},
		{
			entry: commit({ author: null, committer: BOB }),
			expected: [BOB],
			name: "the committer alone when the author is unmapped",
		},
		{
			entry: commit({ author: ALICE, committer: WEB_FLOW_USER }),
			expected: [ALICE],
			name: "no web-flow committer",
		},
		{
			entry: commit({ author: ALICE, committer: WEB_FLOW_LOOKALIKE }),
			expected: [ALICE, WEB_FLOW_LOOKALIKE],
			name: "a web-flow lookalike committer, which must be resolved like any other",
		},
		{
			entry: commit({ author: WEB_FLOW_USER, committer: BOB }),
			expected: [WEB_FLOW_USER, BOB],
			name: "web-flow when it is the author",
		},
		{
			entry: commit({ author: ALICE, committer: ALICE_LOOKALIKE }),
			expected: [ALICE, ALICE_LOOKALIKE],
			name: "both accounts when the committer only shares the author's login",
		},
	])("collects $name", ({ entry, expected }) => {
		expect.hasAssertions();
		expect(commitPrincipals(entry)).toStrictEqual(expected);
	});
});

describe("commit count precheck", () => {
	it.each([
		{ declared: 0, expected: "no-commits" },
		{ declared: 1, expected: null },
		{ declared: MAX_VERIFIABLE_COMMITS, expected: null },
		{ declared: MAX_VERIFIABLE_COMMITS + 1, expected: "too-many-commits" },
	])("returns $expected for $declared declared commits", ({ declared, expected }) => {
		expect.hasAssertions();
		expect(precheckCommitCount(declared)).toBe(expected);
	});
});

describe("fetched commit count", () => {
	it.each(COMMIT_COUNT_CASES)(
		"returns $expected for $fetched fetched of $declared declared",
		({ declared, expected, fetched }) => {
			expect.hasAssertions();
			expect(checkCommitCount(fetched, declared)).toBe(expected);
		},
	);
});

describe("commit verification gate", () => {
	it.each(COMMIT_CASES)("returns $expected for $name", async ({ entry, expected }) => {
		expect.hasAssertions();
		await expect(checkCommit(entry, isTrustedFixture)).resolves.toBe(expected);
	});
});

describe("own approval detection", () => {
	it.each([
		{ expected: true, name: "the bot's approval for the current head", reviews: [review()] },
		{ expected: false, name: "no reviews at all", reviews: [] },
		{ expected: false, name: "a dismissed review only", reviews: [review({ state: "DISMISSED" })] },
		{
			expected: false,
			name: "an approval anchored to another head",
			reviews: [review({ commit_id: "stale-sha" })],
		},
		{ expected: false, name: "an approval by another user", reviews: [review({ user: HUMAN })] },
		{ expected: false, name: "a review without a user", reviews: [review({ user: null })] },
		{
			expected: false,
			name: "a review without a commit id",
			reviews: [review({ commit_id: null })],
		},
		{
			expected: true,
			name: "an approval among unrelated reviews",
			reviews: [
				review({ state: "DISMISSED" }),
				review({ commit_id: "stale-sha" }),
				review({ user: HUMAN }),
				review(),
			],
		},
	])("returns $expected for $name", ({ expected, reviews }) => {
		expect.hasAssertions();
		expect(hasOwnApproval(reviews, BOT_LOGIN, HEAD_SHA)).toBe(expected);
	});
});

describe("live pull request state", () => {
	it.each([
		{ expected: true, name: "an open non-draft pull request on the expected head", overrides: {} },
		{ expected: false, name: "a pull request closed meanwhile", overrides: { state: "closed" } },
		{ expected: false, name: "a pull request turned draft", overrides: { draft: true } },
		{ expected: false, name: "a moved head", overrides: { sha: "moved-sha" } },
	])("returns $expected for $name", ({ expected, overrides }) => {
		expect.hasAssertions();
		expect(isLiveStateCurrent(livePullRequest(overrides), HEAD_SHA)).toBe(expected);
	});
});

describe("webhook payload parsing", () => {
	it("builds a new object instead of returning the input", () => {
		expect.hasAssertions();
		const payload = expectedPayload();
		expect(parsePullRequestEvent(payload)).not.toBe(payload);
	});

	it.each(PARSE_OK_CASES)("parses $name", ({ expected, payload }) => {
		expect.hasAssertions();
		expect(parsePullRequestEvent(payload)).toStrictEqual(expected);
	});

	it.each(MALFORMED_PAYLOADS)("returns null for $name", ({ payload }) => {
		expect.hasAssertions();
		expect(parsePullRequestEvent(payload)).toBeNull();
	});
});
