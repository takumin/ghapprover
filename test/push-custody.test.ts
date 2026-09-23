/**
 * SPEC.md §3.2 push custody: the walk back from the head through the branch's recorded updates,
 * which is what decides who put the coding agent's commits onto the branch. The lookup is injected
 * as a plain predicate, as in the commit suite (SPEC.md §12).
 */

import type { GithubAccount, RepositoryActivity } from "~src/types";
import { describe, expect, it } from "vitest";
import { accountKey } from "~src/account";
import { checkPushCustody } from "~src/commits";

const ALICE: GithubAccount = { id: 101, login: "alice", type: "User" };
const BOB: GithubAccount = { id: 102, login: "bob", type: "User" };
const MALLORY: GithubAccount = { id: 103, login: "mallory", type: "User" };
/** Same login as a trusted user, different account: trust must not follow the login. */
const ALICE_LOOKALIKE: GithubAccount = { id: 909, login: "alice", type: "User" };
const TRUSTED_ACCOUNTS: ReadonlySet<string> = new Set([accountKey(ALICE), accountKey(BOB)]);

async function isTrustedFixture(account: GithubAccount): Promise<boolean> {
	await Promise.resolve();
	return TRUSTED_ACCOUNTS.has(accountKey(account));
}

const HEAD = "head";
const EARLIER = "earlier";
const ZERO = "0000000000000000000000000000000000000000";

interface ActivityOverrides {
	readonly activityType?: string;
	readonly actor?: GithubAccount | null;
}
function activity(
	after: string,
	before: string,
	overrides: ActivityOverrides = {},
): RepositoryActivity {
	const { activityType = "push", actor = ALICE } = overrides;
	return { activity_type: activityType, actor, after, before };
}
const CREATION = activity(EARLIER, ZERO, { activityType: "branch_creation" });

interface CustodyCase {
	readonly expected: string | undefined;
	readonly history: readonly RepositoryActivity[];
	readonly name: string;
}
/* What ends the walk successfully is the branch's creation reached through an unbroken chain of
 * trusted pushes, and nothing else. */
const CUSTODY_CASES: readonly CustodyCase[] = [
	{ expected: undefined, history: [activity(HEAD, EARLIER), CREATION], name: "a trusted chain" },
	{
		expected: undefined,
		history: [activity(HEAD, EARLIER, { actor: BOB }), CREATION],
		name: "a chain of two trusted pushers",
	},
	{
		expected: "untrusted-pusher",
		history: [activity(HEAD, EARLIER, { actor: MALLORY }), CREATION],
		name: "an untrusted push on the chain",
	},
	{
		expected: "untrusted-pusher",
		history: [activity(HEAD, EARLIER), activity(EARLIER, ZERO, { actor: ALICE_LOOKALIKE })],
		name: "a creation by a lookalike of a trusted login",
	},
	{
		expected: "push-history-incomplete",
		history: [activity(HEAD, "gap"), CREATION],
		name: "a chain with a gap",
	},
	{
		expected: "push-history-incomplete",
		history: [activity(HEAD, EARLIER)],
		name: "no creation",
	},
	{ expected: "push-history-incomplete", history: [], name: "no history at all" },
];

describe("push custody", () => {
	it.each(CUSTODY_CASES)(
		"returns $expected for $name",
		{ timeout: 5000 },
		async ({ expected, history }) => {
			expect.hasAssertions();
			await expect(checkPushCustody(history, HEAD, isTrustedFixture)).resolves.toBe(expected);
		},
	);
});
