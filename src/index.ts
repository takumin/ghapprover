/**
 * Worker entry point orchestrating the SPEC.md §4 pipeline per webhook
 * delivery. Processing is synchronous (no ctx.waitUntil), so every outcome is
 * recorded as-is in GitHub's Recent Deliveries and redeliverable (§9).
 */
/* The decision contract and Headers.get model absence as null (SPEC.md fails closed), so null literals are deliberate here. */
/* oxlint-disable unicorn/no-null */

import type { GithubAccount, PullRequestEventPayload } from "./types";
import {
	GithubApiError,
	createApprovalReview,
	createInstallationToken,
	fetchAppSlug,
	fetchOrgMembership,
	fetchPullRequest,
	listPullRequestCommits,
	listPullRequestReviews,
} from "./github";
import {
	checkCommits,
	checkPullRequestState,
	classifyPrincipal,
	collectCommitPrincipals,
	hasOwnApproval,
	isLiveStateCurrent,
	isOwnerMembership,
	isTargetAction,
	parsePullRequestEvent,
	precheckCommitCount,
} from "./decision";
import { createAppJwt } from "./jwt";
import { verifyWebhookSignature } from "./webhook";

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_INTERNAL_ERROR = 500;

/**
 * Evaluation result mapped onto the §9 status table and the §8 log entry.
 * endpoint and status (the GithubApiError fields; 0 = network failure) are
 * set for the github-api-error outcome only.
 */
interface Outcome {
	readonly decision: "approved" | "error" | "skipped";
	readonly endpoint?: string;
	readonly httpStatus: number;
	readonly reason?: string;
	readonly status?: number;
}

/** SPEC.md §8 flat log entry, accumulating fields as they become known per delivery. */
type LogFields = Record<string, number | string>;
/** Derived from the client signature so "./github" stays a single value import. */
type RepoRef = Parameters<typeof fetchPullRequest>[1];

interface TrustResolver {
	/** Sync view over resolved logins for checkCommits; unresolved means untrusted. */
	readonly isTrustedLogin: (login: string) => boolean;
	readonly resolve: (user: GithubAccount) => Promise<boolean>;
}

interface ReviewTarget {
	readonly headSha: string;
	readonly pullNumber: number;
	readonly repo: RepoRef;
}

function skippedOutcome(reason: string): Outcome {
	return { decision: "skipped", httpStatus: HTTP_OK, reason };
}
/** 5xx marks an evaluation that could not be completed: loud in Recent Deliveries, redeliverable (SPEC.md §9). */
function errorOutcome(reason: string): Outcome {
	return { decision: "error", httpStatus: HTTP_INTERNAL_ERROR, reason };
}
function respond(outcome: Outcome): Response {
	const { decision, httpStatus: status, reason } = outcome;
	if (reason === undefined) {
		return Response.json({ decision }, { status });
	}
	return Response.json({ decision, reason }, { status });
}

function recordPayload(log: LogFields, payload: PullRequestEventPayload): void {
	log["action"] = payload.action;
	log["headSha"] = payload.pull_request.head.sha;
	log["prNumber"] = payload.pull_request.number;
	log["repo"] = payload.repository.full_name;
}
/** Exactly one structured log entry per handled webhook delivery (SPEC.md §8). */
function logOutcome(log: LogFields, outcome: Outcome): void {
	log["decision"] = outcome.decision;
	if (outcome.reason !== undefined) {
		log["reason"] = outcome.reason;
	}
	if (outcome.endpoint !== undefined) {
		log["endpoint"] = outcome.endpoint;
	}
	if (outcome.status !== undefined) {
		log["status"] = outcome.status;
	}
	console.log(log);
}
function repoRef(payload: PullRequestEventPayload): RepoRef {
	return { owner: payload.repository.owner.login, repo: payload.repository.name };
}

async function evaluateTrust(
	token: string,
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
	return isOwnerMembership(await fetchOrgMembership(token, evaluation.org, evaluation.login));
}
/** Memoizes per delivery so each distinct login is looked up at most once (SPEC.md §3.1). */
function createTrustResolver(token: string, repoOwner: GithubAccount): TrustResolver {
	const resolved = new Map<string, boolean>();
	const resolve = async (user: GithubAccount): Promise<boolean> => {
		const known = resolved.get(user.login);
		if (known !== undefined) {
			return known;
		}
		const trusted = await evaluateTrust(token, user, repoOwner);
		resolved.set(user.login, trusted);
		return trusted;
	};
	return { isTrustedLogin: (login: string): boolean => resolved.get(login) === true, resolve };
}

/** SPEC.md §4 step 5 (§3.2): fetch all commits and verify every one of them. */
async function checkCommitCondition(
	payload: PullRequestEventPayload,
	token: string,
	trust: TrustResolver,
): Promise<Outcome | null> {
	const { pull_request: pullRequest } = payload;
	const commits = await listPullRequestCommits(token, repoRef(payload), pullRequest.number);
	const principals = collectCommitPrincipals(commits);
	await Promise.all(principals.map(async (account) => trust.resolve(account)));
	const problem = checkCommits(commits, pullRequest.commits, trust.isTrustedLogin);
	if (problem === null) {
		return null;
	}
	return skippedOutcome(problem);
}

/** SPEC.md §4 steps 4-5: the author condition, then the commit condition. */
async function evaluateConditions(
	payload: PullRequestEventPayload,
	token: string,
	trust: TrustResolver,
): Promise<Outcome | null> {
	if (!(await trust.resolve(payload.pull_request.user))) {
		return skippedOutcome("author-not-trusted");
	}
	const countProblem = precheckCommitCount(payload.pull_request.commits);
	if (countProblem !== null) {
		return skippedOutcome(countProblem);
	}
	return checkCommitCondition(payload, token, trust);
}

/** SPEC.md §4 steps 7-8: the live TOCTOU check (§3.3), then the review POST. */
async function submitApproval(token: string, target: ReviewTarget): Promise<Outcome> {
	const { headSha, pullNumber, repo } = target;
	const live = await fetchPullRequest(token, repo, pullNumber);
	if (!isLiveStateCurrent(live, headSha)) {
		return skippedOutcome("head-moved");
	}
	const posted = await createApprovalReview(token, repo, pullNumber, headSha);
	if (posted === "rejected") {
		return skippedOutcome("review-rejected");
	}
	return { decision: "approved", httpStatus: HTTP_OK };
}
/** SPEC.md §4 step 6 (§6): an own APPROVE for this head ends the run successfully. */
async function approvePullRequest(
	payload: PullRequestEventPayload,
	appJwt: string,
	token: string,
): Promise<Outcome> {
	const target: ReviewTarget = {
		headSha: payload.pull_request.head.sha,
		pullNumber: payload.pull_request.number,
		repo: repoRef(payload),
	};
	const slug = await fetchAppSlug(appJwt);
	const reviews = await listPullRequestReviews(token, target.repo, target.pullNumber);
	if (hasOwnApproval(reviews, `${slug}[bot]`, target.headSha)) {
		return skippedOutcome("already-approved");
	}
	return submitApproval(token, target);
}
/** SPEC.md §4 steps 3-8 once the delivery is in scope: authenticate, evaluate, approve. */
async function approveWhenConditionsHold(
	payload: PullRequestEventPayload,
	env: Env,
	installationId: number,
): Promise<Outcome> {
	const appJwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, Date.now());
	const token = await createInstallationToken(appJwt, installationId);
	const trust = createTrustResolver(token, payload.repository.owner);
	const conditions = await evaluateConditions(payload, token, trust);
	if (conditions !== null) {
		return conditions;
	}
	return approvePullRequest(payload, appJwt, token);
}
/** SPEC.md §4 step 2: action scope and PR state precede any API call. */
async function runPipeline(payload: PullRequestEventPayload, env: Env): Promise<Outcome> {
	if (!isTargetAction(payload.action)) {
		return skippedOutcome("event-out-of-scope");
	}
	const stateProblem = checkPullRequestState(payload.pull_request);
	if (stateProblem !== null) {
		return skippedOutcome(stateProblem);
	}
	const { installation } = payload;
	if (installation === null) {
		return errorOutcome("missing-installation");
	}
	return approveWhenConditionsHold(payload, env, installation.id);
}
async function processPayload(payload: PullRequestEventPayload, env: Env): Promise<Outcome> {
	try {
		return await runPipeline(payload, env);
	} catch (error) {
		if (error instanceof GithubApiError) {
			/* SPEC.md §9: keep status and endpoint so 401/403 configuration problems are distinguishable in logs. */
			return {
				decision: "error",
				endpoint: error.endpoint,
				httpStatus: HTTP_INTERNAL_ERROR,
				reason: "github-api-error",
				status: error.status,
			};
		}
		return errorOutcome("internal-error");
	}
}
function parseBody(body: string): PullRequestEventPayload | null {
	try {
		const parsed: unknown = JSON.parse(body);
		return parsePullRequestEvent(parsed);
	} catch {
		return null;
	}
}
/** A body that cannot be modeled means the evaluation could not be completed (SPEC.md §9). */
async function evaluateBody(body: string, env: Env, log: LogFields): Promise<Outcome> {
	const payload = parseBody(body);
	if (payload === null) {
		return errorOutcome("invalid-payload");
	}
	recordPayload(log, payload);
	return processPayload(payload, env);
}
/** SPEC.md §4 step 1 and §9: verify the signature and scope the event before parsing the body. */
async function evaluateDelivery(request: Request, env: Env, log: LogFields): Promise<Outcome> {
	const body = await request.text();
	const verified = await verifyWebhookSignature(
		env.GITHUB_WEBHOOK_SECRET,
		body,
		request.headers.get("x-hub-signature-256"),
	);
	if (!verified) {
		return { decision: "error", httpStatus: HTTP_UNAUTHORIZED, reason: "invalid-signature" };
	}
	if (request.headers.get("x-github-event") !== "pull_request") {
		return skippedOutcome("event-out-of-scope");
	}
	return evaluateBody(body, env, log);
}
async function handleWebhook(request: Request, env: Env): Promise<Response> {
	const log: LogFields = {};
	const deliveryId = request.headers.get("x-github-delivery");
	if (deliveryId !== null) {
		log["deliveryId"] = deliveryId;
	}
	const outcome = await evaluateDelivery(request, env, log);
	logOutcome(log, outcome);
	return respond(outcome);
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		if (request.method !== "POST" || new URL(request.url).pathname !== "/webhook") {
			return respond({ decision: "error", httpStatus: HTTP_NOT_FOUND, reason: "not-found" });
		}
		return handleWebhook(request, env);
	},
} satisfies ExportedHandler<Env>;
