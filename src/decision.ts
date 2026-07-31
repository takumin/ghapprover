/**
 * The §3 approval conditions a single value settles (SPEC.md §3, §4): the event's action and the
 * pull request's state, whether one principal is trusted, and the review and live state checks that
 * bracket the approval. Deterministic and free of I/O of its own, so the conditions are
 * unit-testable without mocking the GitHub API (SPEC.md §12); the one condition that needs a lookup
 * states which query resolves it and leaves the running of it to the caller. The identity every
 * trust decision is made against lives in src/account.ts, and the commit condition (§3.2), which
 * walks a list rather than settling a value, in src/commits.ts.
 */

import type {
	EventPullRequest,
	EventRepository,
	GithubAccount,
	LivePullRequest,
	OrgMembership,
	PullRequestReview,
} from "./types";
import { isAllowedBot, isSameAccount } from "./account";

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
): PrStateProblem | undefined {
	if (pr.state !== "open") {
		return "pr-not-open";
	}
	if (pr.draft) {
		return "pr-draft";
	}
	/* Truthiness rather than a comparison, because the schema leaves both spellings of a gone head
	 * repository as they arrived (src/types.ts) and this check is about neither in particular; the
	 * value is an object when present, so nothing else can be falsy here. */
	if (!pr.head.repo) {
		return "head-repo-missing";
	}
	if (pr.head.repo.id !== repository.id) {
		return "head-repo-forked";
	}
	return undefined;
}

/* The verdict, or the one lookup that resolves it — the membership of the organization that owns
 * the repository. Neither account is restated here: the caller passed both the principal and the
 * repository owner in and still holds them, and a copy of either login is a second place the
 * lookup could be made about somebody else. */
export type TrustEvaluation = "org-membership" | "trusted" | "untrusted";

/* SPEC.md §3.1: bots are trusted solely via the allowlist (login and numeric id both matching)
 * and never fall through to the owner/org checks; users on org repositories resolve through the
 * membership API (the caller runs the returned query); personal-repo users must be the owner,
 * matched on the (id, login) pair like every other §3 identity check — the owner's id is in the
 * same payload, and the org branch below is the only one that decides on a login, because the
 * membership API is what resolves it. */
export function classifyPrincipal(user: GithubAccount, repoOwner: GithubAccount): TrustEvaluation {
	if (user.type === "Bot") {
		if (isAllowedBot(user)) {
			return "trusted";
		}
		return "untrusted";
	}
	if (repoOwner.type === "Organization") {
		return "org-membership";
	}
	if (isSameAccount(user, repoOwner)) {
		return "trusted";
	}
	return "untrusted";
}

/** SPEC.md §3.1: an org owner is an active admin; no membership (404, not a member) is not one. */
export function isOwnerMembership(membership: OrgMembership | undefined): boolean {
	if (membership === undefined) {
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
