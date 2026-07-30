/**
 * The SPEC.md §3 conditions the pull request's own state settles: which actions are in scope
 * (condition 1), whether the event's pull request may be approved at all (condition 2), whether
 * the App has already approved this head (condition 5), and whether the live pull request is still
 * the one the delivery described (§3.3). The §3.1 and §3.2 halves live in trust.test.ts and
 * commits.test.ts.
 */

import { APP_BOT, HEAD_SHA, HUMAN, OWNER, REPOSITORY } from "./fixtures";
import type {
	EventPullRequest,
	GithubAccount,
	LivePullRequest,
	PullRequestReview,
} from "../src/types";
import {
	checkPullRequestState,
	hasOwnApproval,
	isLiveStateCurrent,
	isTargetAction,
} from "../src/decision";
import { describe, expect, it } from "vitest";

const BOT_LOGIN = APP_BOT.login;

interface PrStateOverrides {
	readonly draft?: boolean;
	readonly repo?: { readonly id: number } | null;
	readonly state?: string;
}

function eventPullRequest(overrides: PrStateOverrides = {}): EventPullRequest {
	/* The head repo defaults to the base repository's own id, which is what makes the fixture PR
	 * not a fork. */
	const { draft = false, repo = { id: REPOSITORY.id }, state = "open" } = overrides;
	return { commits: 1, draft, head: { repo, sha: HEAD_SHA }, number: 11, state, user: OWNER };
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
		expect(checkPullRequestState(eventPullRequest(overrides), REPOSITORY)).toBe(expected);
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
