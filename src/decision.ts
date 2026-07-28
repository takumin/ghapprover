/**
 * Decision logic for the approval pipeline (SPEC.md §3, §4): deterministic and free of I/O of its
 * own, so the approval conditions are unit-testable without mocking the GitHub API (SPEC.md §12).
 * The one condition that needs a lookup takes it as an injected predicate rather than reaching for
 * a client, so a test supplies a plain function instead of a stubbed API.
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
import { isRecord, toAccount, toIdRef } from "./parse";

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

/** Derived from the allowlist so "./allowlist" stays a single value import. */
type AccountRef = typeof WEB_FLOW;

/* The identity every §3 trust decision is made against: the (id, login) pair, never the login
 * alone. Every identity comparison below goes through it, and callers that cache or compare
 * principals must key on it too — an account reusing a trusted login would otherwise inherit that
 * trust and defeat the id pinning. Injective, because a numeric id cannot contain the separator. */
export function accountKey(account: AccountRef): string {
	return `${account.id}:${account.login}`;
}

export type TrustEvaluation =
	| { readonly kind: "trusted" }
	| { readonly kind: "untrusted" }
	| { readonly kind: "org-membership"; readonly org: string; readonly login: string };
function isAllowedBot(user: GithubAccount): boolean {
	return ALLOWED_BOTS.some((bot) => accountKey(bot) === accountKey(user));
}
/* SPEC.md §3.2: matched on login and numeric id, like the §3.1 allowlist. Both are identity
 * exemptions that decide approval, so neither may turn on a login string alone. */
function isWebFlow(account: GithubAccount): boolean {
	return accountKey(account) === accountKey(WEB_FLOW);
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

/* SPEC.md §3.2: the fetched list must match the count the payload declared. The declared count
 * itself is settled by precheckCommitCount, which the caller runs before it spends the fetch. */
export function checkCommitCount(
	fetchedCount: number,
	declaredCount: number,
): "commit-count-mismatch" | null {
	if (fetchedCount !== declaredCount) {
		return "commit-count-mismatch";
	}
	return null;
}

/* What §3.2 can settle about one commit, as opposed to about the list (the count problems above).
 * Each check below is typed by what it can actually return, so narrowing one is a local change. */
export type CommitProblem = "untrusted-commit" | "unverified-commit";
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
/* The trust half of §3.2: every principal the commit needs must be trusted. The caller derives
 * them once with commitPrincipals — the single source of which those are, the web-flow committer
 * exemption included — and supplies the lookup as isTrusted, which the loop below both runs and
 * decides on, so the accounts looked up and the accounts checked cannot diverge. It stops at the
 * first untrusted principal: a further lookup could not change this commit's outcome, and a
 * delivery that ends in a skip must not burst one lookup per principal against the Worker
 * subrequest allowance or GitHub's secondary rate limits. Meaningful only for a commit that has
 * passed checkCommitStructure: commitPrincipals drops unmapped principals rather than failing. */
export async function checkCommitTrust(
	principals: readonly GithubAccount[],
	isTrusted: (account: GithubAccount) => Promise<boolean>,
): Promise<"untrusted-commit" | null> {
	for (const account of principals) {
		// oxlint-disable-next-line no-await-in-loop -- sequential by design: parallel lookups are the burst §3.1 memoization cannot bound
		if (!(await isTrusted(account))) {
			return "untrusted-commit";
		}
	}
	return null;
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

/* A deleted head repository is absent rather than malformed, so it parses to null (SPEC.md §3
 * condition 2); undefined is the parse failure, which is what keeps the two apart without boxing the
 * result — the sentinel every narrowing primitive uses (src/parse.ts). */
function parseHeadRepo(value: unknown): PullRequestHead["repo"] | undefined {
	if (value === null || value === undefined) {
		return null;
	}
	return toIdRef(value);
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
	const parsedUser = toAccount(user);
	const parsedHead = parseHead(head);
	if (parsedUser === undefined || parsedHead === null) {
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
	const parsedOwner = toAccount(owner);
	if (parsedOwner === undefined) {
		return null;
	}
	return { full_name: fullName, id, name, owner: parsedOwner };
}

/** Absent or malformed alike leave the payload valid with no installation (SPEC.md §9). */
function parseInstallation(value: unknown): { readonly id: number } | null {
	return toIdRef(value) ?? null;
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
