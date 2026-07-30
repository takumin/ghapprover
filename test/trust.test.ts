/**
 * SPEC.md §3.1 trusted principals: how one account is classified before any API call, and what the
 * membership the org branch defers to has to say for that account to count as an owner. Every
 * near-miss case exists because trust is decided on the (id, login) pair, never the login alone.
 */

import { AUTOFIX_CI, OCTOCAT, ORG, RENOVATE, RENOVATE_WRONG_ID, allowedBot } from "./accounts";
import type { GithubAccount, OrgMembership } from "../src/types";
import { classifyPrincipal, isOwnerMembership } from "../src/decision";
import { describe, expect, it } from "vitest";

/** The owner's login under a different account: §3.1 pins the personal-repo owner's id too. */
const OCTOCAT_WRONG_ID: GithubAccount = { id: 78, login: "octocat", type: "User" };
const OTHER_USER: GithubAccount = { id: 55, login: "someone-else", type: "User" };
const DEPENDABOT = allowedBot("dependabot[bot]");
/** Deliberately not on the allowlist: a bot GitHub ships, which §3.1 still rejects. */
const GITHUB_ACTIONS: GithubAccount = { id: 41_898_282, login: "github-actions[bot]", type: "Bot" };
const AUTOFIX_CI_WRONG_ID = allowedBot("autofix-ci[bot]", { id: 3 });
const RENOVATE_WRONG_LOGIN = allowedBot("renovate[bot]", { login: "renovate-bot" });
const RENOVATE_TYPE_USER = allowedBot("renovate[bot]", { type: "User" });
const BOT_NAMED_OCTOCAT: GithubAccount = { id: 5, login: "octocat", type: "Bot" };
const ACTIVE_ADMIN: OrgMembership = { role: "admin", state: "active" };
const ACTIVE_MEMBER: OrgMembership = { role: "member", state: "active" };
const PENDING_ADMIN: OrgMembership = { role: "admin", state: "pending" };

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
		owner: ORG,
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
		owner: ORG,
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
		owner: ORG,
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
		owner: ORG,
		user: RENOVATE_TYPE_USER,
	},
	{
		expected: { kind: "untrusted" },
		name: "a User named like renovate on a personal repository",
		owner: OCTOCAT,
		user: RENOVATE_TYPE_USER,
	},
];

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
