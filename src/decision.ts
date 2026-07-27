/**
 * Pure decision logic for the approval pipeline (SPEC.md §3, §4): deterministic and I/O-free so
 * the approval conditions are unit-testable without mocking the GitHub API (SPEC.md §11).
 */
/* GitHub payloads and types.ts model absence as null (SPEC.md fails closed), so null literals are deliberate here. */
/* oxlint-disable unicorn/no-null */

import { ALLOWED_BOTS, MAX_VERIFIABLE_COMMITS, WEB_FLOW_LOGIN } from "./allowlist";
import type {
	EventPullRequest,
	EventRepository,
	GithubAccount,
	LivePullRequest,
	OrgMembership,
	PullRequestCommit,
	PullRequestEventPayload,
	PullRequestHead,
	PullRequestReview,
} from "./types";

/** Actions evaluated for approval (SPEC.md §3 condition 1). */
export const TARGET_ACTIONS: readonly string[] = [
	"opened",
	"reopened",
	"synchronize",
	"ready_for_review",
];
const TARGET_ACTION_SET: ReadonlySet<string> = new Set(TARGET_ACTIONS);

export function isTargetAction(action: string): boolean {
	return TARGET_ACTION_SET.has(action);
}

export type PrStateProblem = "head-repo-missing" | "pr-draft" | "pr-not-open";
/** SPEC.md §3 condition 2, plus the deleted-fork guard from the §3 note. */
export function checkPullRequestState(pr: EventPullRequest): PrStateProblem | null {
	if (pr.state !== "open") {
		return "pr-not-open";
	}
	if (pr.draft) {
		return "pr-draft";
	}
	if (pr.head.repo === null) {
		return "head-repo-missing";
	}
	return null;
}

export type TrustEvaluation =
	| { readonly kind: "trusted" }
	| { readonly kind: "untrusted" }
	| { readonly kind: "org-membership"; readonly org: string; readonly login: string };
function isAllowedBot(user: GithubAccount): boolean {
	return ALLOWED_BOTS.some((bot) => bot.id === user.id && bot.login === user.login);
}

/* SPEC.md §3.1: bots are trusted solely via the allowlist (login and numeric id both matching)
 * and never fall through to the owner/org checks; users on org repositories resolve through the
 * membership API (the caller runs the returned query); personal-repo users must be the owner. */
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
	if (user.login === repoOwner.login) {
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

/* The accounts whose trust one commit's §3.2 check needs: the author, and the committer unless
 * it is web-flow (exempt as committer only) or repeats the author. The caller resolves them in
 * commit order, memoized per delivery (§3.1), so a failing commit stops the remaining
 * membership lookups instead of querying every principal of every commit up front. */
export function commitPrincipals(entry: PullRequestCommit): readonly GithubAccount[] {
	const { author, committer } = entry;
	const principals: GithubAccount[] = [];
	if (author !== null) {
		principals.push(author);
	}
	if (
		committer !== null &&
		committer.login !== WEB_FLOW_LOGIN &&
		(author === null || committer.login !== author.login)
	) {
		principals.push(committer);
	}
	return principals;
}

export type CommitCountProblem = "no-commits" | "too-many-commits";
/** SPEC.md §3.2: zero commits, or more than the commits API can return, fail closed. */
export function precheckCommitCount(declaredCount: number): CommitCountProblem | null {
	if (declaredCount === 0) {
		return "no-commits";
	}
	if (declaredCount > MAX_VERIFIABLE_COMMITS) {
		return "too-many-commits";
	}
	return null;
}

export type CommitProblem =
	| CommitCountProblem
	| "commit-count-mismatch"
	| "untrusted-commit"
	| "unverified-commit";
/** SPEC.md §3.2: the count prechecks, then the fetched list must match the declared count. */
export function checkCommitCount(
	fetchedCount: number,
	declaredCount: number,
): CommitProblem | null {
	const countProblem = precheckCommitCount(declaredCount);
	if (countProblem !== null) {
		return countProblem;
	}
	if (fetchedCount !== declaredCount) {
		return "commit-count-mismatch";
	}
	return null;
}

/* SPEC.md §3.2 per commit: the signature verification is checked before author and committer
 * trust; web-flow is accepted as committer only, because genuine web-flow commits are
 * GitHub-signed, which the verification check enforces. */
export function checkCommit(
	entry: PullRequestCommit,
	isTrustedLogin: (login: string) => boolean,
): CommitProblem | null {
	const { author, commit, committer } = entry;
	const { verification } = commit;
	if (verification === null || !verification.verified) {
		return "unverified-commit";
	}
	if (author === null || !isTrustedLogin(author.login)) {
		return "untrusted-commit";
	}
	if (
		committer === null ||
		(committer.login !== WEB_FLOW_LOGIN && !isTrustedLogin(committer.login))
	) {
		return "untrusted-commit";
	}
	return null;
}

/* SPEC.md §3 condition 5: only an APPROVED review by the App's own bot user for the current head
 * suppresses re-approval; DISMISSED reviews do not (they are simply not APPROVED), so a manually
 * dismissed PR can be approved again. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseAccount(value: unknown): GithubAccount | null {
	if (!isRecord(value)) {
		return null;
	}
	const { id, login, type } = value;
	if (typeof id !== "number" || typeof login !== "string" || typeof type !== "string") {
		return null;
	}
	return { id, login, type };
}

function parseHeadRepo(value: unknown): { readonly repo: PullRequestHead["repo"] } | null {
	if (value === null || value === undefined) {
		return { repo: null };
	}
	if (!isRecord(value)) {
		return null;
	}
	const { id } = value;
	if (typeof id !== "number") {
		return null;
	}
	return { repo: { id } };
}

function parseHead(value: unknown): PullRequestHead | null {
	if (!isRecord(value)) {
		return null;
	}
	const { repo, sha } = value;
	if (typeof sha !== "string") {
		return null;
	}
	const parsedRepo = parseHeadRepo(repo);
	if (parsedRepo === null) {
		return null;
	}
	return { repo: parsedRepo.repo, sha };
}

function parsePullRequest(value: unknown): EventPullRequest | null {
	if (!isRecord(value)) {
		return null;
	}
	const { commits, draft, head, number, state, user } = value;
	if (
		typeof number !== "number" ||
		typeof state !== "string" ||
		typeof draft !== "boolean" ||
		typeof commits !== "number"
	) {
		return null;
	}
	const parsedUser = parseAccount(user);
	const parsedHead = parseHead(head);
	if (parsedUser === null || parsedHead === null) {
		return null;
	}
	return { commits, draft, head: parsedHead, number, state, user: parsedUser };
}

function parseRepository(value: unknown): EventRepository | null {
	if (!isRecord(value)) {
		return null;
	}
	const { full_name: fullName, name, owner } = value;
	if (typeof name !== "string" || typeof fullName !== "string") {
		return null;
	}
	const parsedOwner = parseAccount(owner);
	if (parsedOwner === null) {
		return null;
	}
	return { full_name: fullName, name, owner: parsedOwner };
}

function parseInstallation(value: unknown): { readonly id: number } | null {
	if (!isRecord(value)) {
		return null;
	}
	const { id } = value;
	if (typeof id !== "number") {
		return null;
	}
	return { id };
}

/* Fail-closed structural validation (SPEC.md §3): the typed payload is rebuilt field-by-field
 * from narrowed unknown values (never asserted), so a body that does not match the modeled shape
 * yields null. A missing or malformed installation stays null while the payload remains valid. */
export function parsePullRequestEvent(payload: unknown): PullRequestEventPayload | null {
	if (!isRecord(payload)) {
		return null;
	}
	const { action, installation, pull_request: rawPullRequest, repository: rawRepository } = payload;
	if (typeof action !== "string") {
		return null;
	}
	const pullRequest = parsePullRequest(rawPullRequest);
	const repository = parseRepository(rawRepository);
	if (pullRequest === null || repository === null) {
		return null;
	}
	return {
		action,
		installation: parseInstallation(installation),
		pull_request: pullRequest,
		repository,
	};
}
