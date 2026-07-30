/**
 * The SPEC.md §4 pipeline: everything a delivery goes through once its signature has been verified
 * and its body modeled — the §3 conditions in the order they must run, the trust lookups they
 * spend, and the approval itself — reduced to the outcome the entry point logs and answers with
 * (src/index.ts). The outcome vocabulary lives here rather than there because it is the §3 checks
 * that decide what an outcome can say.
 */

import type {
	CommitCountProblem,
	CommitListProblem,
	CommitProblem,
	PrStateProblem,
} from "./decision";
import type { GithubAccount, PullRequestCommit, PullRequestEventPayload } from "./types";
import {
	accountKey,
	checkCommit,
	checkCommitCount,
	checkPullRequestState,
	classifyPrincipal,
	hasOwnApproval,
	isLiveStateCurrent,
	isOwnerMembership,
	isTargetAction,
	precheckCommitCount,
} from "./decision";
import {
	createApprovalReview,
	fetchAppBotLogin,
	fetchOrgMembership,
	fetchPullRequest,
	listPullRequestCommits,
	listPullRequestReviews,
} from "./github";
import type { GithubClient } from "./client";
import type { RepoRef } from "./github";
import { createGithubClient } from "./client";

const HTTP_OK = 200;
const HTTP_INTERNAL_ERROR = 500;

/**
 * SPEC.md §8's reason vocabulary, closed rather than illustrative because it is
 * what an operator greps. The §3 rows are one per decision check, named by what
 * that check can actually return, so a renamed problem there is a compile error
 * here rather than a silent change to the logged vocabulary — and a check
 * narrowed to fewer members is caught here too, rather than being absorbed by a
 * union wide enough to cover its siblings. The rest are outcomes of this module
 * and of the entry point that wraps it.
 */
export type Reason =
	| CommitCountProblem
	| CommitListProblem
	| CommitProblem
	| PrStateProblem
	| "already-approved"
	| "author-not-trusted"
	| "event-out-of-scope"
	| "github-api-error"
	| "head-moved"
	| "internal-error"
	| "invalid-payload"
	| "invalid-signature"
	| "missing-installation"
	| "not-found"
	| "payload-too-large"
	| "review-rejected";

/**
 * Evaluation result mapped onto the §9 status table and the §8 log entry.
 * endpoint, status (0 = network failure) and the three header-derived
 * diagnostics (the GithubApiError fields) are set for the github-api-error
 * outcome only; errorName (a thrown error's class name) for the internal-error
 * outcome only; and errorMessage — the originating error's message, truncated
 * where the entry is built (§12) — for either. The diagnostics are spelled
 * `| undefined` rather than merely optional because the failure paths set them
 * from a failure that may have carried no response at all, and §8 asks for them
 * to be absent from the entry rather than logged empty.
 */
export interface Outcome {
	readonly acceptedPermissions?: string | undefined;
	readonly decision: "approved" | "error" | "skipped";
	readonly endpoint?: string;
	readonly errorMessage?: string | undefined;
	readonly errorName?: string;
	readonly httpStatus: number;
	readonly rateLimitRemaining?: string | undefined;
	readonly rateLimitReset?: string | undefined;
	readonly reason?: Reason;
	readonly requestId?: string | undefined;
	readonly status?: number;
}

/** Resolves one account's §3.1 trust, memoized per delivery; see createTrustResolver. */
type TrustResolver = (user: GithubAccount) => Promise<boolean>;

interface ReviewTarget {
	readonly headSha: string;
	readonly pullNumber: number;
	readonly repo: RepoRef;
}

export function skippedOutcome(reason: Reason): Outcome {
	return { decision: "skipped", httpStatus: HTTP_OK, reason };
}
/* A non-2xx marks an evaluation that could not be completed: loud in Recent Deliveries and
 * redeliverable (SPEC.md §9). 5xx is the default because that is what §9 maps every failure to
 * except the three the request itself settles (404, 401, 413). */
export function errorOutcome(reason: Reason, httpStatus: number = HTTP_INTERNAL_ERROR): Outcome {
	return { decision: "error", httpStatus, reason };
}

function repoRef(payload: PullRequestEventPayload): RepoRef {
	return { owner: payload.repository.owner.login, repo: payload.repository.name };
}

async function evaluateTrust(
	client: GithubClient,
	user: GithubAccount,
	repoOwner: GithubAccount,
): Promise<boolean> {
	const evaluation = classifyPrincipal(user, repoOwner);
	if (evaluation.kind === "trusted") {
		return true;
	}
	if (evaluation.kind === "untrusted") {
		return false;
	}
	return isOwnerMembership(await fetchOrgMembership(client, evaluation.org, evaluation.login));
}
/* Memoizes per delivery so each distinct account is looked up at most once (SPEC.md §3.1).
 * The key is the accountKey pair, not the login: evaluateTrust decides on the id as well
 * (§3.1 allowlist, §3.2 web-flow), so a login-keyed cache would hand a trusted account's
 * verdict to any other account reusing that login and undo the id pinning. */
function createTrustResolver(client: GithubClient, repoOwner: GithubAccount): TrustResolver {
	const resolved = new Map<string, boolean>();
	return async (user: GithubAccount): Promise<boolean> => {
		const key = accountKey(user);
		const known = resolved.get(key);
		if (known !== undefined) {
			return known;
		}
		const trusted = await evaluateTrust(client, user, repoOwner);
		resolved.set(key, trusted);
		return trusted;
	};
}

/* SPEC.md §3.2 in commit order: checkCommit settles one commit (spending a lookup only on what it
 * cannot settle without one), and the first failing commit ends the loop, so a delivery that ends
 * in a skip never bursts a lookup per principal against the Worker subrequest allowance or
 * GitHub's secondary rate limits. */
async function findCommitProblem(
	commits: readonly PullRequestCommit[],
	trust: TrustResolver,
): Promise<CommitProblem | null> {
	for (const entry of commits) {
		const problem = await checkCommit(entry, trust);
		if (problem !== null) {
			return problem;
		}
	}
	return null;
}

/** SPEC.md §4 step 5 (§3.2): the declared count, then every fetched commit verified. */
async function checkCommitCondition(
	payload: PullRequestEventPayload,
	client: GithubClient,
	trust: TrustResolver,
): Promise<Outcome | null> {
	const { pull_request: pullRequest } = payload;
	/* Ahead of the fetch: what the declared count alone settles costs no subrequest to decide. */
	const declaredProblem = precheckCommitCount(pullRequest.commits);
	if (declaredProblem !== null) {
		return skippedOutcome(declaredProblem);
	}
	const commits = await listPullRequestCommits(client, repoRef(payload), pullRequest.number);
	/* A list that does not match the declared count settles the condition on its own, so the
	 * per-commit walk (and the membership lookups it spends) only runs once the list is whole. */
	const problem =
		checkCommitCount(commits.length, pullRequest.commits) ??
		(await findCommitProblem(commits, trust));
	if (problem !== null) {
		return skippedOutcome(problem);
	}
	return null;
}

/** SPEC.md §4 steps 4-5: the author condition, then the commit condition. */
async function evaluateConditions(
	payload: PullRequestEventPayload,
	client: GithubClient,
	trust: TrustResolver,
): Promise<Outcome | null> {
	if (!(await trust(payload.pull_request.user))) {
		return skippedOutcome("author-not-trusted");
	}
	return checkCommitCondition(payload, client, trust);
}

/** SPEC.md §4 steps 7-8: the live TOCTOU check (§3.3), then the review POST. */
async function submitApproval(client: GithubClient, target: ReviewTarget): Promise<Outcome> {
	const { headSha, pullNumber, repo } = target;
	const live = await fetchPullRequest(client, repo, pullNumber);
	if (!isLiveStateCurrent(live, headSha)) {
		return skippedOutcome("head-moved");
	}
	const posted = await createApprovalReview(client, { commitId: headSha, pullNumber, repo });
	if (posted === "rejected") {
		return skippedOutcome("review-rejected");
	}
	return { decision: "approved", httpStatus: HTTP_OK };
}
/** SPEC.md §4 step 6 (§6): an own APPROVE for this head ends the run successfully. */
async function approvePullRequest(
	payload: PullRequestEventPayload,
	client: GithubClient,
): Promise<Outcome> {
	const target: ReviewTarget = {
		headSha: payload.pull_request.head.sha,
		pullNumber: payload.pull_request.number,
		repo: repoRef(payload),
	};
	/* Independent: GET /app takes no argument the reviews list produces, and both feed only the
	 * check below. Concurrency here is not the burst §3.1 memoization cannot bound — that is the
	 * per-principal membership lookups, whose count follows the PR — but two fixed calls, so the
	 * round trip they would otherwise serialize is spent out of the delivery budget for nothing. */
	const [botLogin, reviews] = await Promise.all([
		fetchAppBotLogin(client),
		listPullRequestReviews(client, target.repo, target.pullNumber),
	]);
	if (hasOwnApproval(reviews, botLogin, target.headSha)) {
		return skippedOutcome("already-approved");
	}
	return submitApproval(client, target);
}
/** SPEC.md §4 steps 3-8: the auth strategy signs the JWT and issues the token on first use. */
async function approveWhenConditionsHold(
	payload: PullRequestEventPayload,
	env: Env,
	installationId: number,
): Promise<Outcome> {
	const client = createGithubClient(
		{ appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY },
		installationId,
	);
	const trust = createTrustResolver(client, payload.repository.owner);
	const conditions = await evaluateConditions(payload, client, trust);
	if (conditions !== null) {
		return conditions;
	}
	return approvePullRequest(payload, client);
}
/** SPEC.md §4 step 2: action scope and PR state precede any API call. */
export async function runPipeline(payload: PullRequestEventPayload, env: Env): Promise<Outcome> {
	if (!isTargetAction(payload.action)) {
		return skippedOutcome("event-out-of-scope");
	}
	const stateProblem = checkPullRequestState(payload.pull_request, payload.repository);
	if (stateProblem !== null) {
		return skippedOutcome(stateProblem);
	}
	if (payload.installation === undefined || payload.installation === null) {
		return errorOutcome("missing-installation");
	}
	return approveWhenConditionsHold(payload, env, payload.installation.id);
}
