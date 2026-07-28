/**
 * Worker entry point orchestrating the SPEC.md §4 pipeline per webhook delivery.
 * Processing is synchronous (no ctx.waitUntil), so every outcome is recorded
 * as-is in GitHub's Recent Deliveries and redeliverable (§9).
 */
/* The decision contract and Headers.get model absence as null (SPEC.md fails closed), so null literals are deliberate here. */
/* oxlint-disable unicorn/no-null */
/* oxlint-disable max-lines -- the §4 pipeline and its outcome mapping live in one module by design */

import type { GithubAccount, PullRequestCommit, PullRequestEventPayload } from "./types";
import {
	GithubApiError,
	createApprovalReview,
	createGithubClient,
	fetchAppSlug,
	fetchOrgMembership,
	fetchPullRequest,
	listPullRequestCommits,
	listPullRequestReviews,
} from "./github";
import {
	accountKey,
	checkCommit,
	checkCommitCount,
	checkPullRequestState,
	classifyPrincipal,
	commitPrincipals,
	hasOwnApproval,
	isLiveStateCurrent,
	isOwnerMembership,
	isTargetAction,
	parsePullRequestEvent,
	precheckCommitCount,
} from "./decision";
import { verifyWebhookSignature } from "./webhook";

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_INTERNAL_ERROR = 500;

/**
 * GitHub caps webhook payloads at 25 MB, so anything larger is not a delivery
 * this Worker could act on. The HMAC covers the raw body, so the body must be
 * buffered before the caller can be authenticated (SPEC.md §4 step 1) — the
 * declared length is the one thing that can be checked first, and it bounds
 * what an unauthenticated caller on the public endpoint can make the Worker
 * hold in memory and hash. A body sent without a usable Content-Length (e.g.
 * chunked) is still read: rejecting those would reject genuine deliveries.
 */
const MAX_BODY_BYTES = 26_214_400;

/**
 * Evaluation result mapped onto the §9 status table and the §8 log entry.
 * endpoint and status (the GithubApiError fields; 0 = network failure) are
 * set for the github-api-error outcome only; errorName (a thrown error's
 * class name, never its message) for the internal-error outcome only.
 */
interface Outcome {
	readonly decision: "approved" | "error" | "skipped";
	readonly endpoint?: string;
	readonly errorName?: string;
	readonly httpStatus: number;
	readonly reason?: string;
	readonly status?: number;
}

/** SPEC.md §8 flat log entry, accumulating fields as they become known per delivery. */
type LogFields = Record<string, number | string>;
/** Derived from the client signatures so "./github" stays a single value import. */
type GithubClient = ReturnType<typeof createGithubClient>;
type RepoRef = Parameters<typeof fetchPullRequest>[1];

interface TrustResolver {
	/** Sync view over resolved accounts for checkCommits; unresolved means untrusted. */
	readonly isTrusted: (user: GithubAccount) => boolean;
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
	if (outcome.errorName !== undefined) {
		log["errorName"] = outcome.errorName;
	}
	console.log(log);
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
	const resolve = async (user: GithubAccount): Promise<boolean> => {
		const key = accountKey(user);
		const known = resolved.get(key);
		if (known !== undefined) {
			return known;
		}
		const trusted = await evaluateTrust(client, user, repoOwner);
		resolved.set(key, trusted);
		return trusted;
	};
	const isTrusted = (user: GithubAccount): boolean => resolved.get(accountKey(user)) === true;
	return { isTrusted, resolve };
}

/** Trust stub that projects checkCommit onto its trust-independent problems. */
const everyAccountTrusted = (): boolean => true;
/* SPEC.md §3.2 in commit order, resolving each commit's principals lazily and one at a time
 * (memoized, §3.1). Trust-independent problems (verification, unmapped principals) are checked
 * before that commit's lookups, and the first failing commit stops the loop — so a delivery
 * that ends in a skip never bursts a lookup per principal against the Worker subrequest
 * allowance or GitHub's secondary rate limits. */
async function findCommitProblem(
	commits: readonly PullRequestCommit[],
	trust: TrustResolver,
): Promise<ReturnType<typeof checkCommit>> {
	for (const entry of commits) {
		const structural = checkCommit(entry, everyAccountTrusted);
		if (structural !== null) {
			return structural;
		}
		for (const account of commitPrincipals(entry)) {
			// oxlint-disable-next-line no-await-in-loop -- sequential by design: parallel lookups are the burst §3.1 memoization cannot bound
			await trust.resolve(account);
		}
		const problem = checkCommit(entry, trust.isTrusted);
		if (problem !== null) {
			return problem;
		}
	}
	return null;
}

/** SPEC.md §4 step 5 (§3.2): fetch all commits and verify every one of them. */
async function checkCommitCondition(
	payload: PullRequestEventPayload,
	client: GithubClient,
	trust: TrustResolver,
): Promise<Outcome | null> {
	const { pull_request: pullRequest } = payload;
	const commits = await listPullRequestCommits(client, repoRef(payload), pullRequest.number);
	const countProblem = checkCommitCount(commits.length, pullRequest.commits);
	if (countProblem !== null) {
		return skippedOutcome(countProblem);
	}
	const problem = await findCommitProblem(commits, trust);
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
	if (!(await trust.resolve(payload.pull_request.user))) {
		return skippedOutcome("author-not-trusted");
	}
	const countProblem = precheckCommitCount(payload.pull_request.commits);
	if (countProblem !== null) {
		return skippedOutcome(countProblem);
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
	const posted = await createApprovalReview(client, repo, pullNumber, headSha);
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
	const slug = await fetchAppSlug(client);
	const reviews = await listPullRequestReviews(client, target.repo, target.pullNumber);
	if (hasOwnApproval(reviews, `${slug}[bot]`, target.headSha)) {
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
async function runPipeline(payload: PullRequestEventPayload, env: Env): Promise<Outcome> {
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
/** The thrown value's class name only — never its message, which could carry anything (§8). */
function thrownErrorName(error: unknown): string {
	if (error instanceof Error) {
		return error.name;
	}
	return "unknown";
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
		/* SPEC.md §9: the bounded class name keeps configuration mistakes (e.g. a PKCS#1 key the
		 * auth library rejects) distinguishable from code bugs without touching §8's leak surface. */
		return {
			decision: "error",
			errorName: thrownErrorName(error),
			httpStatus: HTTP_INTERNAL_ERROR,
			reason: "internal-error",
		};
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
/** True only for a Content-Length that parses and exceeds the cap; anything else is read. */
function exceedsBodyLimit(header: string | null): boolean {
	if (header === null) {
		return false;
	}
	const declared = Number(header);
	return Number.isFinite(declared) && declared > MAX_BODY_BYTES;
}
/** SPEC.md §4 step 1 and §9: verify the signature and scope the event before parsing the body. */
async function evaluateDelivery(request: Request, env: Env, log: LogFields): Promise<Outcome> {
	if (exceedsBodyLimit(request.headers.get("content-length"))) {
		return {
			decision: "error",
			httpStatus: HTTP_PAYLOAD_TOO_LARGE,
			reason: "payload-too-large",
		};
	}
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
/* SPEC.md §8 and §9: processPayload only guards the pipeline, but reading the body and
 * verifying the signature run before it and can reject on their own — a client disconnect
 * or a truncated chunked upload rejects request.text(). Without this the Worker would
 * answer with the runtime's own 500 and leave no log entry at all, which is the one
 * outcome §8 does not allow; "any other thrown failure" is §9's internal-error. */
async function evaluateOrFail(request: Request, env: Env, log: LogFields): Promise<Outcome> {
	try {
		return await evaluateDelivery(request, env, log);
	} catch (error) {
		return {
			decision: "error",
			errorName: thrownErrorName(error),
			httpStatus: HTTP_INTERNAL_ERROR,
			reason: "internal-error",
		};
	}
}
async function handleWebhook(request: Request, env: Env): Promise<Response> {
	const log: LogFields = {};
	const deliveryId = request.headers.get("x-github-delivery");
	if (deliveryId !== null) {
		log["deliveryId"] = deliveryId;
	}
	const outcome = await evaluateOrFail(request, env, log);
	logOutcome(log, outcome);
	return respond(outcome);
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		if (request.method !== "POST" || new URL(request.url).pathname !== "/webhook") {
			/* SPEC.md §8: the reason vocabulary is what an operator greps, and a webhook URL
			 * pointing at the wrong path is exactly what not-found exists to surface — so it
			 * has to leave a log entry, not only a 404 body. No delivery fields are known. */
			const outcome: Outcome = {
				decision: "error",
				httpStatus: HTTP_NOT_FOUND,
				reason: "not-found",
			};
			logOutcome({}, outcome);
			return respond(outcome);
		}
		return handleWebhook(request, env);
	},
} satisfies ExportedHandler<Env>;
