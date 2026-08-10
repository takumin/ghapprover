/**
 * SPEC.md §3.2, the commit condition: what the declared count settles on its own, what the fetched
 * list must match, and what every commit in it has to satisfy — its signature, and the trust of the
 * one principal that signature binds. Split from the other §3 checks (src/decision.ts) because this
 * is the one condition that walks a list and spends a lookup per commit, so the order its halves
 * run in and the point the walk stops at are load-bearing arguments rather than a single predicate.
 * Deterministic and free of I/O like the rest of §3: the lookup arrives as an injected predicate, so
 * a test supplies a plain function instead of a stubbed API (SPEC.md §12).
 */

import type { GithubAccount, PullRequestCommit } from "./types";
import { isWebFlow } from "./account";

/**
 * The PR commits API returns at most 250 commits, so a PR declaring more can never be fully
 * verified and is not approved (SPEC.md §3.2). A capability limit of the endpoint rather than an
 * approval constant, so it lives with the check that reads it and not in src/account.ts (§5).
 */
const MAX_VERIFIABLE_COMMITS = 250;

/* The one account §3.2 decides a commit on: the principal its verified signature binds. GitHub
 * checks a signature against the committer's email address and never the author's, so the committer
 * is the only party a verified commit is attributed to — `author` is a field that same party filled
 * in freely, with no key behind it. The one exception is a GitHub-signed commit, whose committer is
 * web-flow and therefore names no actor: there the author is the actor, which is safe for the reason
 * the §3.2 NOTE gives — GitHub does not sign a commit whose author the caller chose. Absent when the
 * payload maps no account for whichever of the two decides, which the caller fails closed on rather
 * than deciding the commit on the account that does not. The two arguments arrive as GitHub sends
 * them, `null` and all; what this answers with is absence as the rest of the code says it. */
function commitPrincipal(
	author: GithubAccount | null,
	committer: GithubAccount | null,
): GithubAccount | undefined {
	if (committer === null) {
		return undefined;
	}
	if (isWebFlow(committer)) {
		return author ?? undefined;
	}
	return committer;
}

/**
 * What §3.2 can settle about a pull request's commits: the two the declared count settles on its
 * own, the one the fetched list settles against it, and the two one commit can fail on. One
 * vocabulary for the whole condition rather than one alias per check — the checks run in a single
 * frame (src/pipeline.ts) and reach SPEC.md §8 as one reason each, so an alias apiece only made the
 * reason vocabulary (src/outcome.ts) name this module three times over to say "§3.2".
 */
type CommitProblem =
	| "commit-count-mismatch"
	| "no-commits"
	| "too-many-commits"
	| "untrusted-commit"
	| "unverified-commit";

/** SPEC.md §3.2: zero commits, or more than the commits API can return, fail closed. */
function precheckCommitCount(declaredCount: number): CommitProblem | undefined {
	if (declaredCount === 0) {
		return "no-commits";
	}
	if (declaredCount > MAX_VERIFIABLE_COMMITS) {
		return "too-many-commits";
	}
	return undefined;
}

/* SPEC.md §3.2: the fetched list must match the count the payload declared. The declared count
 * itself is settled by precheckCommitCount, which the caller runs before it spends the fetch. */
function checkCommitCount(fetchedCount: number, declaredCount: number): CommitProblem | undefined {
	if (fetchedCount !== declaredCount) {
		return "commit-count-mismatch";
	}
	return undefined;
}

/**
 * The injected §3.1 trust lookup the walks below run (SPEC.md §12): the pipeline supplies its
 * per-delivery memoized resolver, a suite a plain function. Declared once here, where the
 * contract is consumed, so the caller building one and the checks running it cannot drift apart.
 */
type TrustResolver = (account: GithubAccount) => Promise<boolean>;

/* SPEC.md §3.2 for one commit, in the order the checks must run: the signature, then the trust of
 * the principal it binds. Both are load-bearing in that order — the committer is the principal only
 * *because* a verified signature is checked against its email, and the web-flow branch that hands
 * the decision to the author instead is only safe once the signature is known to be GitHub's own.
 * Running the signature first also means no membership lookup is spent on a commit that fails it. A
 * principal the payload does not map fails the commit rather than being dropped from the walk. */
async function checkCommit(
	entry: PullRequestCommit,
	isTrusted: TrustResolver,
): Promise<CommitProblem | undefined> {
	const { author, commit, committer } = entry;
	const { verification } = commit;
	if (verification === null || !verification.verified) {
		return "unverified-commit";
	}
	const principal = commitPrincipal(author, committer);
	if (principal === undefined) {
		return "untrusted-commit";
	}
	if (!(await isTrusted(principal))) {
		return "untrusted-commit";
	}
	return undefined;
}
/* SPEC.md §3.2 for the whole list, in commit order: checkCommit settles one commit, spending a
 * lookup only on what its signature check leaves open, and the first failing commit ends the loop —
 * no later commit can change an outcome already settled, and a delivery that ends in a skip must
 * not burst a lookup per commit against the Worker subrequest allowance or GitHub's secondary rate
 * limits. The walk lives here with the check it repeats, so that argument is made once and the
 * caller is left with the fetch it sequences around it. */
async function checkCommits(
	commits: readonly PullRequestCommit[],
	isTrusted: TrustResolver,
): Promise<CommitProblem | undefined> {
	for (const entry of commits) {
		// oxlint-disable-next-line eslint/no-await-in-loop -- sequential by design: the first failing commit must end the walk before another lookup is spent
		const problem = await checkCommit(entry, isTrusted);
		if (problem !== undefined) {
			return problem;
		}
	}
	return undefined;
}

export {
	MAX_VERIFIABLE_COMMITS,
	checkCommit,
	checkCommitCount,
	checkCommits,
	commitPrincipal,
	precheckCommitCount,
};
export type { CommitProblem, TrustResolver };
