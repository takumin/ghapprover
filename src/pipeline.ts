/**
 * The SPEC.md §4 pipeline: everything a delivery goes through once its signature has been verified
 * and its body modeled — the §3 conditions in the order they must run, the trust lookups they
 * spend, and the approval itself — reduced to the outcome the entry point logs and answers with
 * (src/index.ts). What an outcome can say is the vocabulary in src/outcome.ts; this module is what
 * decides which one a delivery reaches.
 */

import type { ApprovalTarget, RepoRef } from "./github";
import type { GithubAccount, PullRequestEventPayload } from "./types";
import {
	accountKey,
	checkCommitCount,
	checkCommits,
	checkPullRequestState,
	classifyPrincipal,
	hasOwnApproval,
	isLiveStateCurrent,
	isOwnerMembership,
	isTargetAction,
	precheckCommitCount,
} from "./decision";
import { apiErrorOutcome, approvedOutcome, errorOutcome, skippedOutcome } from "./outcome";
import {
	createApprovalReview,
	fetchAppBotLogin,
	fetchOrgMembership,
	fetchPullRequest,
	listPullRequestCommits,
	listPullRequestReviews,
} from "./github";
import { GithubApiError } from "./api-error";
import type { GithubClient } from "./client";
import type { Outcome } from "./outcome";
import { createGithubClient } from "./client";

/** Resolves one account's §3.1 trust, memoized per delivery; see createTrustResolver. */
type TrustResolver = (user: GithubAccount) => Promise<boolean>;

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
		checkCommitCount(commits.length, pullRequest.commits) ?? (await checkCommits(commits, trust));
	if (problem !== null) {
		return skippedOutcome(problem);
	}
	return null;
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
async function approvePullRequest(
	payload: PullRequestEventPayload,
	client: GithubClient,
): Promise<Outcome> {
	const target: ApprovalTarget = {
		commitId: payload.pull_request.head.sha,
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
	if (hasOwnApproval(reviews, botLogin, target.commitId)) {
		return skippedOutcome("already-approved");
	}
	return submitApproval(client, target);
}
/**
 * SPEC.md §4 steps 3-8, in the order they must run: the client, whose auth strategy signs the JWT
 * and issues the token on first use, then the author condition (step 4), the commit condition
 * (step 5), and the approval.
 */
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
	if (!(await trust(payload.pull_request.user))) {
		return skippedOutcome("author-not-trusted");
	}
	const commitOutcome = await checkCommitCondition(payload, client, trust);
	if (commitOutcome !== null) {
		return commitOutcome;
	}
	return approvePullRequest(payload, client);
}
/** SPEC.md §4 step 2: action scope and PR state precede any API call. */
async function evaluateApproval(payload: PullRequestEventPayload, env: Env): Promise<Outcome> {
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
/**
 * The pipeline, with the one failure its own calls raise mapped onto an outcome (SPEC.md §9): every
 * endpoint in src/github.ts throws GithubApiError, so this is where that contract is read. Anything
 * else thrown travels on to the entry point's catch-all, which owns §9's "any other thrown failure".
 */
export async function runPipeline(payload: PullRequestEventPayload, env: Env): Promise<Outcome> {
	try {
		return await evaluateApproval(payload, env);
	} catch (error) {
		if (error instanceof GithubApiError) {
			return apiErrorOutcome(error);
		}
		throw error;
	}
}
