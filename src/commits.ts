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
import { isSameAccount, isWebFlow } from "./account";

/**
 * The PR commits API returns at most 250 commits, so a PR declaring more can never be fully
 * verified and is not approved (SPEC.md §3.2). A capability limit of the endpoint rather than an
 * approval constant, so it lives with the check that reads it and not in src/account.ts (§5).
 */
export const MAX_VERIFIABLE_COMMITS = 250;

/* The accounts whose trust one commit's §3.2 check needs: the author, and the committer unless it
 * is web-flow (exempt as committer only — this is the one place that exemption is applied) or
 * repeats the author. Both arrive mapped, which is what checkCommit below establishes before it
 * derives them — an unmapped principal fails the commit rather than being dropped from the walk.
 * The caller resolves them in commit order, memoized per delivery (§3.1), so a failing commit stops
 * the remaining membership lookups instead of querying every principal of every commit up front. */
export function commitPrincipals(
	author: GithubAccount,
	committer: GithubAccount,
): readonly GithubAccount[] {
	if (isWebFlow(committer) || isSameAccount(committer, author)) {
		return [author];
	}
	return [author, committer];
}

/**
 * What §3.2 can settle about a pull request's commits: the two the declared count settles on its
 * own, the one the fetched list settles against it, and the two one commit can fail on. One
 * vocabulary for the whole condition rather than one alias per check — the checks run in a single
 * frame (src/pipeline.ts) and reach SPEC.md §8 as one reason each, so an alias apiece only made the
 * reason vocabulary (src/outcome.ts) name this module three times over to say "§3.2".
 */
export type CommitProblem =
	| "commit-count-mismatch"
	| "no-commits"
	| "too-many-commits"
	| "untrusted-commit"
	| "unverified-commit";

/** SPEC.md §3.2: zero commits, or more than the commits API can return, fail closed. */
export function precheckCommitCount(declaredCount: number): CommitProblem | null {
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
): CommitProblem | null {
	if (fetchedCount !== declaredCount) {
		return "commit-count-mismatch";
	}
	return null;
}

/**
 * The injected §3.1 trust lookup the walks below run (SPEC.md §12): the pipeline supplies its
 * per-delivery memoized resolver, a suite a plain function. Declared once here, where the
 * contract is consumed, so the caller building one and the checks running it cannot drift apart.
 */
export type TrustResolver = (account: GithubAccount) => Promise<boolean>;

/* SPEC.md §3.2 for one commit, in the order the checks must run: the signature, then the principals
 * the payload has to map at all, then their trust. Both directions of that order are load-bearing —
 * what a commit can be settled by without a lookup comes first, so no membership lookup is spent on
 * a commit that fails either, and the web-flow committer exemption commitPrincipals applies is only
 * safe once the signature check has run, genuine web-flow commits being GitHub-signed. Stated in
 * this one frame, so a caller cannot compose the checks in an order that gets it wrong — and the
 * two guards are what let commitPrincipals take its principals as mapped accounts.
 *
 * The trust walk runs the injected lookup and decides on it in the same loop, so the accounts looked
 * up and the accounts checked cannot diverge, and it stops at the first untrusted principal: a
 * further lookup could not change this commit's outcome, and a delivery that ends in a skip must not
 * burst one lookup per principal against the Worker subrequest allowance or GitHub's secondary rate
 * limits. */
export async function checkCommit(
	entry: PullRequestCommit,
	isTrusted: TrustResolver,
): Promise<CommitProblem | null> {
	const { author, commit, committer } = entry;
	const { verification } = commit;
	if (verification === null || !verification.verified) {
		return "unverified-commit";
	}
	if (author === null || committer === null) {
		return "untrusted-commit";
	}
	for (const account of commitPrincipals(author, committer)) {
		if (!(await isTrusted(account))) {
			return "untrusted-commit";
		}
	}
	return null;
}
/* SPEC.md §3.2 for the whole list, in commit order: checkCommit settles one commit (spending a
 * lookup only on what it cannot settle without one), and the first failing commit ends the loop for
 * the same reason its principal walk stops at the first untrusted account — a delivery that ends in
 * a skip must not burst a lookup per principal of every commit against the Worker subrequest
 * allowance or GitHub's secondary rate limits. The walk lives here with the check it repeats, so
 * that argument is made once and the caller is left with the fetch it sequences around it. */
export async function checkCommits(
	commits: readonly PullRequestCommit[],
	isTrusted: TrustResolver,
): Promise<CommitProblem | null> {
	for (const entry of commits) {
		const problem = await checkCommit(entry, isTrusted);
		if (problem !== null) {
			return problem;
		}
	}
	return null;
}
