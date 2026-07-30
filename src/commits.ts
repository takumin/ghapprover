/**
 * SPEC.md §3.2, the commit condition: what the declared count settles on its own, what the fetched
 * list must match, and what every commit in it has to satisfy — its signature, the principals the
 * payload maps for it, and their trust. Split from the other §3 checks (src/decision.ts) because
 * this is the one condition that walks a list and spends a lookup per principal, so the order its
 * halves run in and the point each walk stops at are load-bearing arguments rather than a single
 * predicate. Deterministic and free of I/O like the rest of §3: the lookup arrives as an injected
 * predicate, so a test supplies a plain function instead of a stubbed API (SPEC.md §12).
 */

import type { GithubAccount, PullRequestCommit } from "./types";
import { WEB_FLOW } from "./allowlist";
import { accountKey } from "./decision";

/**
 * The PR commits API returns at most 250 commits, so a PR declaring more can never be fully
 * verified and is not approved (SPEC.md §3.2). A capability limit of the endpoint rather than an
 * approval constant, so it lives with the check that reads it and not in src/allowlist.ts (§5).
 */
export const MAX_VERIFIABLE_COMMITS = 250;

/* Derived once at module scope: both lists are in-code constants (SPEC.md §5), and isWebFlow runs
 * once per commit principal, so deriving it per call is work every delivery repeats for nothing. */
const WEB_FLOW_KEY = accountKey(WEB_FLOW);
/* SPEC.md §3.2: matched on login and numeric id, like the §3.1 allowlist. Both are identity
 * exemptions that decide approval, so neither may turn on a login string alone. */
function isWebFlow(account: GithubAccount): boolean {
	return accountKey(account) === WEB_FLOW_KEY;
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

export type CommitListProblem = "commit-count-mismatch";
/* SPEC.md §3.2: the fetched list must match the count the payload declared. The declared count
 * itself is settled by precheckCommitCount, which the caller runs before it spends the fetch. */
export function checkCommitCount(
	fetchedCount: number,
	declaredCount: number,
): CommitListProblem | null {
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
function checkCommitStructure(entry: PullRequestCommit): CommitProblem | null {
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
 * passed checkCommitStructure: commitPrincipals drops unmapped principals rather than failing,
 * which is why checkCommit below owns the order rather than leaving it to each caller. */
async function checkCommitTrust(
	principals: readonly GithubAccount[],
	isTrusted: (account: GithubAccount) => Promise<boolean>,
): Promise<"untrusted-commit" | null> {
	for (const account of principals) {
		if (!(await isTrusted(account))) {
			return "untrusted-commit";
		}
	}
	return null;
}

/* SPEC.md §3.2 for one commit: the whole per-commit check, with the order its two halves must run
 * in made structural rather than left to the caller. Both directions of that order are load-bearing
 * — the trust-independent half settles a commit before any membership lookup is spent on it, and
 * the web-flow committer exemption commitPrincipals applies is only safe once the signature check
 * has run — so a caller composing the halves itself is a caller that can get it wrong. */
export async function checkCommit(
	entry: PullRequestCommit,
	isTrusted: (account: GithubAccount) => Promise<boolean>,
): Promise<CommitProblem | null> {
	const structural = checkCommitStructure(entry);
	if (structural !== null) {
		return structural;
	}
	return checkCommitTrust(commitPrincipals(entry), isTrusted);
}
/* SPEC.md §3.2 for the whole list, in commit order: checkCommit settles one commit (spending a
 * lookup only on what it cannot settle without one), and the first failing commit ends the loop for
 * the same reason checkCommitTrust stops at the first untrusted principal — a delivery that ends in
 * a skip must not burst a lookup per principal of every commit against the Worker subrequest
 * allowance or GitHub's secondary rate limits. The walk lives here with the check it repeats, so
 * that argument is made once and the caller is left with the fetch it sequences around it. */
export async function checkCommits(
	commits: readonly PullRequestCommit[],
	isTrusted: (account: GithubAccount) => Promise<boolean>,
): Promise<CommitProblem | null> {
	for (const entry of commits) {
		const problem = await checkCommit(entry, isTrusted);
		if (problem !== null) {
			return problem;
		}
	}
	return null;
}
