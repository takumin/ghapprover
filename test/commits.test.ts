/**
 * SPEC.md §3.2 commit verification: which of a commit's two accounts the condition is decided on,
 * what the declared and fetched commit counts settle without a lookup, and the per-commit gate
 * itself. The lookup is injected as a plain predicate, which is what lets the whole matrix run
 * without the GitHub API (SPEC.md §12).
 */

import type { GithubAccount, PullRequestCommit } from "~src/types";
import {
	MAX_VERIFIABLE_COMMITS,
	checkCommit,
	checkCommitCount,
	commitPrincipal,
	precheckCommitCount,
} from "~src/commits";
import { WEB_FLOW_LOOKALIKE, WEB_FLOW_USER } from "./fixtures";
import { describe, expect, it } from "vitest";
import { accountKey } from "~src/account";

const ALICE: GithubAccount = { id: 101, login: "alice", type: "User" };
const BOB: GithubAccount = { id: 102, login: "bob", type: "User" };
const MALLORY: GithubAccount = { id: 103, login: "mallory", type: "User" };
/** Same login as a trusted user, different account: trust must not follow the login. */
const ALICE_LOOKALIKE: GithubAccount = { id: 909, login: "alice", type: "User" };
const TRUSTED_ACCOUNTS: ReadonlySet<string> = new Set([accountKey(ALICE), accountKey(BOB)]);

/** Stands in for the pipeline's membership lookup: it settles on a later microtask, as the
 * network-backed resolver it replaces does, rather than answering within the same tick. */
async function isTrustedFixture(account: GithubAccount): Promise<boolean> {
	await Promise.resolve();
	return TRUSTED_ACCOUNTS.has(accountKey(account));
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

interface CommitCase {
	readonly entry: PullRequestCommit;
	readonly expected: string | undefined;
	readonly name: string;
}

/* The matrix is stated as the two halves §3.2 decides on — what the committer settles, and what
 * the author settles in the one case the committer is GitHub — because the same account in the
 * other field must not change the answer: an untrusted author under a trusted committer is the
 * ordinary case of a maintainer committing somebody else's patch, and a trusted author over an
 * untrusted committer is what forging the author field would look like. */
const COMMIT_CASES: readonly CommitCase[] = [
	{ entry: commit(), expected: undefined, name: "a verified commit from a trusted committer" },
	{
		entry: commit({ author: MALLORY }),
		expected: undefined,
		name: "an untrusted author under a trusted committer",
	},
	{
		entry: commit({ author: null }),
		expected: undefined,
		name: "an unmapped author under a trusted committer",
	},
	{
		entry: commit({ author: ALICE_LOOKALIKE }),
		expected: undefined,
		name: "an author reusing a trusted login under another id, which is not what decides",
	},
	{
		entry: commit({ committer: MALLORY }),
		expected: "untrusted-commit",
		name: "an untrusted committer",
	},
	{
		entry: commit({ author: BOB, committer: MALLORY }),
		expected: "untrusted-commit",
		name: "an untrusted committer under a trusted author",
	},
	{
		entry: commit({ committer: null }),
		expected: "untrusted-commit",
		name: "an unmapped committer",
	},
	{
		entry: commit({ committer: ALICE_LOOKALIKE }),
		expected: "untrusted-commit",
		name: "a committer reusing a trusted login under another id",
	},
	{
		entry: commit({ committer: WEB_FLOW_USER }),
		expected: undefined,
		name: "a web-flow committer with a trusted author",
	},
	{
		entry: commit({ author: MALLORY, committer: WEB_FLOW_USER }),
		expected: "untrusted-commit",
		name: "a web-flow committer with an untrusted author",
	},
	{
		entry: commit({ author: null, committer: WEB_FLOW_USER }),
		expected: "untrusted-commit",
		name: "a web-flow committer with an unmapped author",
	},
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
	{
		entry: commit({ committer: MALLORY, verification: null }),
		expected: "unverified-commit",
		name: "unverified before untrusted on one commit",
	},
];

interface CommitCountCase {
	readonly declared: number;
	readonly expected: string | undefined;
	readonly fetched: number;
}

const COMMIT_COUNT_CASES: readonly CommitCountCase[] = [
	{ declared: 2, expected: "commit-count-mismatch", fetched: 1 },
	{ declared: 1, expected: "commit-count-mismatch", fetched: 2 },
	{ declared: 2, expected: undefined, fetched: 2 },
];

/* Which account a commit is decided on (SPEC.md §3.2): the committer the verified signature binds,
 * or the author where GitHub is the committer and therefore names no actor. An unmapped account is
 * a case here rather than a guard the caller runs first, because which of the two has to be mapped
 * is this function's answer too — the other one is not read at all. */
describe("commit principal selection", () => {
	it.each([
		{
			author: MALLORY,
			committer: BOB,
			expected: BOB,
			name: "the committer, whatever the author field says",
		},
		{
			author: ALICE,
			committer: null,
			expected: undefined,
			name: "nothing when the committer is unmapped",
		},
		{
			author: ALICE,
			committer: WEB_FLOW_USER,
			expected: ALICE,
			name: "the author when GitHub itself is the committer",
		},
		{
			author: null,
			committer: WEB_FLOW_USER,
			expected: undefined,
			name: "nothing when GitHub is the committer and the author is unmapped",
		},
		{
			author: ALICE,
			committer: WEB_FLOW_LOOKALIKE,
			expected: WEB_FLOW_LOOKALIKE,
			name: "a web-flow lookalike committer, which decides the commit like any other",
		},
	] as const)("selects $name", { timeout: 5000 }, ({ author, committer, expected }) => {
		expect.hasAssertions();
		expect(commitPrincipal(author, committer)).toBe(expected);
	});
});

describe("commit count precheck", () => {
	it.each([
		{ declared: 0, expected: "no-commits" },
		{ declared: 1, expected: undefined },
		{ declared: MAX_VERIFIABLE_COMMITS, expected: undefined },
		{ declared: MAX_VERIFIABLE_COMMITS + 1, expected: "too-many-commits" },
	] as const)(
		"returns $expected for $declared declared commits",
		{ timeout: 5000 },
		({ declared, expected }) => {
			expect.hasAssertions();
			expect(precheckCommitCount(declared)).toBe(expected);
		},
	);
});

describe("fetched commit count", () => {
	it.each(COMMIT_COUNT_CASES)(
		"returns $expected for $fetched fetched of $declared declared",
		{ timeout: 5000 },
		({ declared, expected, fetched }) => {
			expect.hasAssertions();
			expect(checkCommitCount(fetched, declared)).toBe(expected);
		},
	);
});

describe("commit verification gate", () => {
	it.each(COMMIT_CASES)(
		"returns $expected for $name",
		{ timeout: 5000 },
		async ({ entry, expected }) => {
			expect.hasAssertions();
			await expect(checkCommit(entry, isTrustedFixture)).resolves.toBe(expected);
		},
	);
});
