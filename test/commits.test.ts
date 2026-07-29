/**
 * SPEC.md §3.2 commit verification: which principals one commit puts up for a trust lookup, what
 * the declared and fetched commit counts settle without one, and the per-commit gate itself. The
 * lookup is injected as a plain predicate, which is what lets the whole matrix run without the
 * GitHub API (SPEC.md §12).
 */

import type { GithubAccount, PullRequestCommit } from "../src/types";
import { WEB_FLOW_LOOKALIKE, WEB_FLOW_USER } from "./accounts";
import {
	accountKey,
	checkCommit,
	checkCommitCount,
	commitPrincipals,
	precheckCommitCount,
} from "../src/decision";
import { describe, expect, it } from "vitest";
import { MAX_VERIFIABLE_COMMITS } from "../src/allowlist";

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
