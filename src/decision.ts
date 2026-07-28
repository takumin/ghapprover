/**
 * Pure decision logic for the approval pipeline (SPEC.md §3, §4): deterministic and I/O-free so
 * the approval conditions are unit-testable without mocking the GitHub API (SPEC.md §12).
 */
/* GitHub payloads and types.ts model absence as null (SPEC.md fails closed), so null literals are deliberate here. */
/* oxlint-disable unicorn/no-null */
/* oxlint-disable max-lines -- every §3 condition and the fail-closed payload parser belong to one pure module (SPEC.md §12) */

import { ALLOWED_BOTS, MAX_VERIFIABLE_COMMITS, WEB_FLOW } from "./allowlist";
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

export function isTargetAction(action: string): boolean {
	return TARGET_ACTIONS.includes(action);
}

export type PrStateProblem = "head-repo-forked" | "head-repo-missing" | "pr-draft" | "pr-not-open";
/* SPEC.md §3 condition 2, plus the §3 note's head-repository guards: deleted head repos and forks. */
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

export type TrustEvaluation =
	| { readonly kind: "trusted" }
	| { readonly kind: "untrusted" }
	| { readonly kind: "org-membership"; readonly org: string; readonly login: string };
function isAllowedBot(user: GithubAccount): boolean {
	return ALLOWED_BOTS.some((bot) => bot.id === user.id && bot.login === user.login);
}
/* SPEC.md §3.2: matched on login and numeric id, like the §3.1 allowlist. Both are identity
 * exemptions that decide approval, so neither may turn on a login string alone. */
function isWebFlow(account: GithubAccount): boolean {
	return account.id === WEB_FLOW.id && account.login === WEB_FLOW.login;
}

/* The identity every §3 trust decision is made against: the (id, login) pair, never the login
 * alone. Callers that cache or compare principals must key on this, or an account reusing a
 * trusted login would inherit that trust and defeat the id pinning above. */
export function accountKey(account: GithubAccount): string {
	return `${account.id}:${account.login}`;
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
		!isWebFlow(committer) &&
		(author === null || accountKey(committer) !== accountKey(author))
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

/* The half of the §3.2 per-commit check that does not depend on trust: the signature
 * verification, then the principals the payload has to map at all. Split out so the caller can
 * settle a commit on these before spending a membership lookup on it — and it must run before
 * checkCommitTrust, because the web-flow committer exemption that half applies rests on genuine
 * web-flow commits being GitHub-signed, which is what the verification check here enforces. */
export function checkCommitStructure(entry: PullRequestCommit): CommitProblem | null {
	const { author, commit, committer } = entry;
	const { verification } = commit;
	if (verification === null || !verification.verified) {
		return "unverified-commit";
	}
	if (author === null || committer === null) {
		return "untrusted-commit";
	}
	return null;
}
/* The trust half of §3.2: every principal the commit needs must be trusted. commitPrincipals is
 * the single source of which those are — the web-flow committer exemption included — so the rule
 * is stated once and the caller resolves exactly the accounts this checks. Meaningful only for a
 * commit that has passed checkCommitStructure: commitPrincipals drops unmapped principals rather
 * than failing on them. */
export function checkCommitTrust(
	entry: PullRequestCommit,
	isTrusted: (account: GithubAccount) => boolean,
): CommitProblem | null {
	if (commitPrincipals(entry).every((account) => isTrusted(account))) {
		return null;
	}
	return "untrusted-commit";
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

/* A deleted head repository is absent rather than malformed, so it parses to null (SPEC.md §3
 * note); undefined is the parse failure, which is what keeps the two apart without boxing the
 * result — the same sentinel the response mappers use (src/github.ts). */
function parseHeadRepo(value: unknown): PullRequestHead["repo"] | undefined {
	if (value === null || value === undefined) {
		return null;
	}
	if (!isRecord(value)) {
		return undefined;
	}
	const { id } = value;
	if (typeof id !== "number") {
		return undefined;
	}
	return { id };
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
	if (parsedRepo === undefined) {
		return null;
	}
	return { repo: parsedRepo, sha };
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
	const { full_name: fullName, id, name, owner } = value;
	if (typeof id !== "number" || typeof name !== "string" || typeof fullName !== "string") {
		return null;
	}
	const parsedOwner = parseAccount(owner);
	if (parsedOwner === null) {
		return null;
	}
	return { full_name: fullName, id, name, owner: parsedOwner };
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
