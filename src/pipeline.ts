/**
 * The SPEC.md §4 pipeline: everything a delivery goes through once its signature has been verified
 * — the body modeled fail-closed (§3, §11), then the §3 conditions in the order they must run, the
 * trust lookups they spend, and the approval itself — reduced to the outcome the entry point logs
 * and answers with (src/index.ts). What an outcome can say is the vocabulary in src/outcome.ts; this
 * module is what decides which one a delivery reaches. The modeling lives here rather than in a
 * module of its own because it is §4's own first step on the verified body and its answer is read at
 * one seam only — src/index.ts models the body and hands the modeled payload straight to the run
 * below. The schema it defers to (src/types.ts) is what decides whether the delivery can be modeled
 * at all, and the §3 checks it feeds are their own modules (src/decision.ts, src/commits.ts), free
 * of I/O and unit-testable without the API (§12).
 */

import type { AppCredentials, GithubClient } from "./client";
import type { ApprovalTarget, RepoRef } from "./github";
import type { CommitProblem, TrustResolver } from "./commits";
import type { EventPullRequest, GithubAccount, PullRequestEventPayload } from "./types";
import { apiErrorOutcome, approvedOutcome, errorOutcome, skippedOutcome } from "./outcome";
import { checkCommitCount, checkCommits, precheckCommitCount } from "./commits";
import {
	checkPullRequestState,
	classifyPrincipal,
	hasOwnApproval,
	isLiveStateCurrent,
	isOwnerMembership,
	isTargetAction,
} from "./decision";
import {
	createApprovalReview,
	fetchAppBotLogin,
	fetchOrgMembership,
	fetchPullRequest,
	listPullRequestCommits,
	listPullRequestReviews,
} from "./github";
import { getDotPath, safeParse } from "valibot";
import { GithubApiError } from "./api-error";
import type { Outcome } from "./outcome";
import { accountKey } from "./account";
import { createGithubClient } from "./client";
import { pullRequestEventSchema } from "./types";

/**
 * The modeled payload, or no payload and SPEC.md §8's `field`: the dot path of the first field that
 * failed validation. The path alone — the issue also carries the value that failed, which is
 * webhook payload content and never leaves this module (§8 warning, §11).
 */
interface PayloadValidation {
	readonly field?: string | undefined;
	readonly payload?: PullRequestEventPayload | undefined;
}

/* The whole body, or no payload at all when it does not match the modeled shape — a missing or
 * malformed installation being the one divergence the schema absorbs rather than rejects (SPEC.md
 * §9). The first issue is the one reported: the schema states its fields in a fixed order, so which
 * field a given malformed body names does not vary between deliveries. */
function parsePullRequestEvent(payload: unknown): PayloadValidation {
	const result = safeParse(pullRequestEventSchema, payload);
	if (result.success) {
		return { payload: result.output };
	}
	/* An issue at the root — a body that is not an object at all has no field to name — has no dot
	 * path, and becomes an absent `field` rather than one logged empty (SPEC.md §8). */
	return { field: getDotPath(result.issues[0]) ?? undefined };
}

/**
 * The delivery body itself, which is what the entry point actually holds: whether it is JSON at all
 * is a fact about the body's validity, so it is settled here rather than at the seam that reads it.
 * A body that is not JSON is not the modeled shape either, and names no field: there is no document
 * to locate one in (SPEC.md §8).
 */
function parsePullRequestEventBody(body: string): PayloadValidation {
	try {
		const parsed: unknown = JSON.parse(body);
		return parsePullRequestEvent(parsed);
	} catch {
		return {};
	}
}

async function evaluateTrust(
	client: GithubClient,
	user: GithubAccount,
	repoOwner: GithubAccount,
): Promise<boolean> {
	const evaluation = classifyPrincipal(user, repoOwner);
	if (evaluation !== "org-membership") {
		return evaluation === "trusted";
	}
	/* The org is the repository owner this call was made about, read from the account the caller
	 * passed in rather than from a login the classification copied out of it. */
	return isOwnerMembership(await fetchOrgMembership(client, repoOwner.login, user.login));
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

/**
 * SPEC.md §4 step 5 (§3.2): the declared count, then every fetched commit verified. Answers with
 * the §3.2 problem it found, like every other §3 check, rather than with the outcome that problem
 * becomes — the mapping of a problem onto a skip is the caller's, stated once for all of §3.
 */
async function checkCommitCondition(
	pullRequest: EventPullRequest,
	call: { readonly client: GithubClient; readonly repo: RepoRef; readonly trust: TrustResolver },
): Promise<CommitProblem | undefined> {
	const { client, repo, trust } = call;
	/* Ahead of the fetch: what the declared count alone settles costs no subrequest to decide. */
	const declaredProblem = precheckCommitCount(pullRequest.commits);
	if (declaredProblem !== undefined) {
		return declaredProblem;
	}
	const commits = await listPullRequestCommits(client, repo, pullRequest.number);
	/* A list that does not match the declared count settles the condition on its own, so the
	 * per-commit walk (and the membership lookups it spends) only runs once the list is whole. */
	return (
		checkCommitCount(commits.length, pullRequest.commits) ?? (await checkCommits(commits, trust))
	);
}

/** SPEC.md §4 steps 7-8: the live TOCTOU check (§3.3), then the review POST. */
async function submitApproval(client: GithubClient, target: ApprovalTarget): Promise<Outcome> {
	const { commitId, pullNumber, repo } = target;
	const live = await fetchPullRequest(client, repo, pullNumber);
	if (!isLiveStateCurrent(live, commitId)) {
		return skippedOutcome("head-moved");
	}
	const posted = await createApprovalReview(client, target);
	if (posted === "rejected") {
		return skippedOutcome("review-rejected");
	}
	return approvedOutcome();
}
/** SPEC.md §4 step 6 (§6): an own APPROVE for this head ends the run successfully. */
async function approvePullRequest(client: GithubClient, target: ApprovalTarget): Promise<Outcome> {
	/* Independent: GET /app takes no argument the reviews list produces, and both feed only the
	 * check below. Concurrency here is not the burst §3.1 memoization cannot bound — that is the
	 * per-commit membership lookups, whose count follows the PR — but two fixed calls, so the
	 * round trip they would otherwise serialize is spent out of the delivery budget for nothing. */
	const [botLogin, reviews] = await Promise.all([
		fetchAppBotLogin(client),
		listPullRequestReviews(client, target.repo, target.pullNumber),
	]);
	if (hasOwnApproval(reviews, botLogin, target.commitId)) {
		return skippedOutcome("already-approved");
	}
	return submitApproval(client, target);
}
/**
 * SPEC.md §4 steps 3-8, in the order they must run: the client, whose auth strategy signs the JWT
 * and issues the token on first use, then the author condition (step 4), the commit condition
 * (step 5), and the approval. The repository the calls are made against is derived once here, at
 * the seam between the payload and the GitHub API, rather than by each step from the payload again.
 */
async function approveWhenConditionsHold(
	payload: PullRequestEventPayload,
	credentials: AppCredentials,
	installationId: number,
): Promise<Outcome> {
	const client = createGithubClient(credentials, installationId);
	const { pull_request: pullRequest, repository } = payload;
	const repo: RepoRef = { owner: repository.owner.login, repo: repository.name };
	const trust = createTrustResolver(client, repository.owner);
	if (!(await trust(pullRequest.user))) {
		return skippedOutcome("author-not-trusted");
	}
	const commitProblem = await checkCommitCondition(pullRequest, { client, repo, trust });
	if (commitProblem !== undefined) {
		return skippedOutcome(commitProblem);
	}
	return approvePullRequest(client, {
		commitId: pullRequest.head.sha,
		pullNumber: pullRequest.number,
		repo,
	});
}
/** SPEC.md §4 step 2: action scope and PR state precede any API call. */
async function evaluateApproval(
	payload: PullRequestEventPayload,
	credentials: AppCredentials,
): Promise<Outcome> {
	if (!isTargetAction(payload.action)) {
		return skippedOutcome("event-out-of-scope");
	}
	const stateProblem = checkPullRequestState(payload.pull_request, payload.repository);
	if (stateProblem !== undefined) {
		return skippedOutcome(stateProblem);
	}
	/* Truthiness rather than a comparison per spelling: absent, `null`, and malformed all reach here
	 * as an installation that is not there (src/types.ts), and the value is an object when it is. */
	if (!payload.installation) {
		return errorOutcome("missing-installation");
	}
	const outcome = await approveWhenConditionsHold(payload, credentials, payload.installation.id);
	return outcome;
}
/**
 * The pipeline, with the one failure its own calls raise mapped onto an outcome (SPEC.md §9): every
 * endpoint in src/github.ts throws GithubApiError, so this is where that contract is read. Anything
 * else thrown travels on to the entry point's catch-all, which owns §9's "any other thrown failure".
 */
async function runPipeline(
	payload: PullRequestEventPayload,
	credentials: AppCredentials,
): Promise<Outcome> {
	try {
		return await evaluateApproval(payload, credentials);
	} catch (error) {
		if (error instanceof GithubApiError) {
			return apiErrorOutcome(error);
		}
		throw error;
	}
}

export { parsePullRequestEvent, parsePullRequestEventBody, runPipeline };
