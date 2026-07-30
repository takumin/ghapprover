/**
 * The §3 approval conditions a single value settles (SPEC.md §3, §4): the event's action and the
 * pull request's state, the identity every trust decision is made against, and the review and live
 * state checks that bracket the approval. Deterministic and free of I/O of its own, so the
 * conditions are unit-testable without mocking the GitHub API (SPEC.md §12); the one condition that
 * needs a lookup states which query resolves it and leaves the running of it to the caller. The
 * commit condition (§3.2) walks a list rather than settling a value and lives in src/commits.ts,
 * built on the identity key defined here.
 */

import type {
	EventPullRequest,
	EventRepository,
	GithubAccount,
	LivePullRequest,
	OrgMembership,
	PullRequestReview,
} from "./types";
import { ALLOWED_BOTS } from "./allowlist";
import type { AccountRef } from "./allowlist";

/** Actions evaluated for approval (SPEC.md §3 condition 1). */
const TARGET_ACTIONS: ReadonlySet<string> = new Set([
	"opened",
	"reopened",
	"synchronize",
	"ready_for_review",
]);

export function isTargetAction(action: string): boolean {
	return TARGET_ACTIONS.has(action);
}

export type PrStateProblem = "head-repo-forked" | "head-repo-missing" | "pr-draft" | "pr-not-open";
/* SPEC.md §3 condition 2: state and draft, plus the head-repository guards it covers —
 * a deleted head repo, and a head repo that is not the one the event came from (a fork). */
export function checkPullRequestState(
	pr: EventPullRequest,
	repository: EventRepository,
): PrStateProblem | null {
	if (pr.state !== "open") {
		return "pr-not-open";
	}
	if (pr.draft) {
		return "pr-draft";
	}
	if (pr.head.repo === null) {
		return "head-repo-missing";
	}
	if (pr.head.repo.id !== repository.id) {
		return "head-repo-forked";
	}
	return null;
}

/* The identity every §3 trust decision is made against: the (id, login) pair, never the login
 * alone. Every identity comparison below goes through it, as do the §3.2 checks in src/commits.ts,
 * and callers that cache or compare principals must key on it too — an account reusing a trusted
 * login would otherwise inherit that trust and defeat the id pinning. Injective, because a numeric
 * id cannot contain the separator. */
export function accountKey(account: AccountRef): string {
	return `${account.id}:${account.login}`;
}

export type TrustEvaluation =
	| { readonly kind: "trusted" }
	| { readonly kind: "untrusted" }
	| { readonly kind: "org-membership"; readonly org: string; readonly login: string };
/* The §3.1 allowlist as the keys it is compared against, derived once at module scope like
 * TARGET_ACTIONS above: the list is an in-code constant (SPEC.md §5), so deriving it per call is
 * work every delivery repeats for nothing. */
const ALLOWED_BOT_KEYS: ReadonlySet<string> = new Set(ALLOWED_BOTS.map((bot) => accountKey(bot)));
function isAllowedBot(user: GithubAccount): boolean {
	return ALLOWED_BOT_KEYS.has(accountKey(user));
}

/* SPEC.md §3.1: bots are trusted solely via the allowlist (login and numeric id both matching)
 * and never fall through to the owner/org checks; users on org repositories resolve through the
 * membership API (the caller runs the returned query); personal-repo users must be the owner,
 * matched on the (id, login) pair like every other §3 identity check — the owner's id is in the
 * same payload, and the org branch below is the only one that decides on a login, because the
 * membership API is what resolves it. */
export function classifyPrincipal(user: GithubAccount, repoOwner: GithubAccount): TrustEvaluation {
	if (user.type === "Bot") {
		if (isAllowedBot(user)) {
			return { kind: "trusted" };
		}
		return { kind: "untrusted" };
	}
	if (repoOwner.type === "Organization") {
		return { kind: "org-membership", login: user.login, org: repoOwner.login };
	}
	if (accountKey(user) === accountKey(repoOwner)) {
		return { kind: "trusted" };
	}
	return { kind: "untrusted" };
}

/** SPEC.md §3.1: an org owner is an active admin; null (404, not a member) is not one. */
export function isOwnerMembership(membership: OrgMembership | null): boolean {
	if (membership === null) {
		return false;
	}
	return membership.state === "active" && membership.role === "admin";
}

/* SPEC.md §3 condition 5: only an APPROVED review by the App's own bot user for the current head
 * suppresses re-approval; DISMISSED reviews do not (they are simply not APPROVED), so a manually
 * dismissed PR can be approved again. Matching on login alone (unlike the §3.1 allowlist, which
 * also pins an id) is deliberate: GET /app returns the App's id, not its bot user's, and "[" is
 * not legal in a login, so "<slug>[bot]" is unforgeable; a false match would only suppress. */
export function hasOwnApproval(
	reviews: readonly PullRequestReview[],
	botLogin: string,
	headSha: string,
): boolean {
	return reviews.some(({ commit_id: commitId, state, user }) => {
		if (user === null) {
			return false;
		}
		return user.login === botLogin && state === "APPROVED" && commitId === headSha;
	});
}

/** SPEC.md §3.3: the live PR must still be open, non-draft, and on the payload's head. */
export function isLiveStateCurrent(live: LivePullRequest, expectedHeadSha: string): boolean {
	return live.state === "open" && !live.draft && live.head.sha === expectedHeadSha;
}
