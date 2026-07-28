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
	fetchAppBotLogin,
	fetchOrgMembership,
	fetchPullRequest,
	listPullRequestCommits,
	listPullRequestReviews,
} from "./github";
import {
	accountKey,
	checkCommitCount,
	checkCommitStructure,
	checkCommitTrust,
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
 * buffered before the caller can be authenticated (SPEC.md §4 step 1), and this
 * is the cap on what an unauthenticated caller on the public endpoint can make
 * the Worker hold in memory and hash.
 */
const MAX_BODY_BYTES = 26_214_400;

/**
 * SPEC.md §8's reason vocabulary, closed rather than illustrative because it is
 * what an operator greps. The §3 rows are the decision module's own unions, so
 * a renamed problem there is a compile error here rather than a silent change
 * to the logged vocabulary; the rest are this module's outcomes. Derived from
 * the decision signatures so "./decision" stays a single value import.
 */
type Reason =
	| NonNullable<ReturnType<typeof checkCommitStructure>>
	| NonNullable<ReturnType<typeof checkPullRequestState>>
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
 * endpoint and status (the GithubApiError fields; 0 = network failure) are
 * set for the github-api-error outcome only; errorName (a thrown error's
 * class name, never its message) for the internal-error outcome only.
 */
interface Outcome {
	readonly decision: "approved" | "error" | "skipped";
	readonly endpoint?: string;
	readonly errorName?: string;
	readonly httpStatus: number;
	readonly reason?: Reason;
	readonly status?: number;
}

/** SPEC.md §8 flat log entry, accumulating fields as they become known per delivery. */
type LogFields = Record<string, number | string>;
/** Derived from the client signatures so "./github" stays a single value import. */
type GithubClient = ReturnType<typeof createGithubClient>;
type RepoRef = Parameters<typeof fetchPullRequest>[1];

/** Resolves one account's §3.1 trust, memoized per delivery; see createTrustResolver. */
type TrustResolver = (user: GithubAccount) => Promise<boolean>;

interface ReviewTarget {
	readonly headSha: string;
	readonly pullNumber: number;
	readonly repo: RepoRef;
}

function skippedOutcome(reason: Reason): Outcome {
	return { decision: "skipped", httpStatus: HTTP_OK, reason };
}
/* A non-2xx marks an evaluation that could not be completed: loud in Recent Deliveries and
 * redeliverable (SPEC.md §9). 5xx is the default because that is what §9 maps every failure to
 * except the three the request itself settles (404, 401, 413). */
function errorOutcome(reason: Reason, httpStatus: number = HTTP_INTERNAL_ERROR): Outcome {
	return { decision: "error", httpStatus, reason };
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
/** The §8 fields an outcome carries only for the outcomes they apply to; httpStatus is not logged. */
const OPTIONAL_LOG_FIELDS = ["reason", "endpoint", "status", "errorName"] as const;
/** Exactly one structured log entry per handled webhook delivery (SPEC.md §8). */
function logOutcome(log: LogFields, outcome: Outcome): void {
	log["decision"] = outcome.decision;
	for (const key of OPTIONAL_LOG_FIELDS) {
		const value = outcome[key];
		if (value !== undefined) {
			log[key] = value;
		}
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

/* SPEC.md §3.2 in commit order. A trust-independent problem settles the commit before any lookup
 * runs, and the first failing commit ends the loop, so a delivery that ends in a skip never
 * bursts a lookup per principal against the Worker subrequest allowance or GitHub's secondary
 * rate limits. */
async function findCommitProblem(
	commits: readonly PullRequestCommit[],
	trust: TrustResolver,
): Promise<ReturnType<typeof checkCommitStructure>> {
	for (const entry of commits) {
		const structural = checkCommitStructure(entry);
		if (structural !== null) {
			return structural;
		}
		// oxlint-disable-next-line no-await-in-loop -- sequential by design: the first failing commit ends the loop, so later commits must not be resolved up front
		const problem = await checkCommitTrust(commitPrincipals(entry), trust);
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
	return runPipeline(payload, env);
}
/** True only for a Content-Length that parses and exceeds the cap; anything else goes to the read. */
function exceedsBodyLimit(header: string | null): boolean {
	if (header === null) {
		return false;
	}
	const declared = Number(header);
	return Number.isFinite(declared) && declared > MAX_BODY_BYTES;
}
/**
 * The stream decoded as text, or null as soon as it passes the cap — the count is
 * what actually bounds the read, so it stops there instead of after the fact, and
 * returning from the loop cancels the stream rather than draining the rest.
 * Decoding matches Request.text(): invalid UTF-8 becomes U+FFFD, which then fails
 * the HMAC, so the bound is all that changes about how the body is read.
 */
async function readCappedStream(stream: ReadableStream<Uint8Array>): Promise<string | null> {
	const decoder = new TextDecoder();
	let read = 0;
	let body = "";
	for await (const chunk of stream) {
		read += chunk.byteLength;
		if (read > MAX_BODY_BYTES) {
			return null;
		}
		body += decoder.decode(chunk, { stream: true });
	}
	return body + decoder.decode();
}
/**
 * The delivery body, or null when it exceeds the cap (SPEC.md §9). A declared length
 * over the cap is rejected before a byte is buffered, but it cannot be the bound: it
 * is absent on a chunked upload, and the same unauthenticated caller decides whether
 * to send it at all. The byte count is the bound; this header only saves the read.
 */
async function readBoundedBody(request: Request): Promise<string | null> {
	if (exceedsBodyLimit(request.headers.get("content-length"))) {
		return null;
	}
	/* Request.body is ReadableStream<any> in the Workers types; the runtime yields chunks
	 * of bytes, which is what the cap counts and the decoder consumes. */
	const stream: ReadableStream<Uint8Array> | null = request.body;
	if (stream === null) {
		return "";
	}
	return readCappedStream(stream);
}
/** SPEC.md §4 step 1 and §9: verify the signature and scope the event before parsing the body. */
async function evaluateDelivery(request: Request, env: Env, log: LogFields): Promise<Outcome> {
	const body = await readBoundedBody(request);
	if (body === null) {
		return errorOutcome("payload-too-large", HTTP_PAYLOAD_TOO_LARGE);
	}
	const verified = await verifyWebhookSignature(
		env.GITHUB_WEBHOOK_SECRET,
		body,
		request.headers.get("x-hub-signature-256"),
	);
	if (!verified) {
		return errorOutcome("invalid-signature", HTTP_UNAUTHORIZED);
	}
	if (request.headers.get("x-github-event") !== "pull_request") {
		return skippedOutcome("event-out-of-scope");
	}
	return evaluateBody(body, env, log);
}
/** True for anything but POST /webhook: a misdirected request, not a delivery to evaluate. */
function isMisrouted(request: Request): boolean {
	return request.method !== "POST" || new URL(request.url).pathname !== "/webhook";
}
/* SPEC.md §8: the reason vocabulary is what an operator greps, and a webhook URL pointing at the
 * wrong path is exactly what not-found exists to surface — so it has to leave a log entry, not
 * only a 404 body. Settled on the evaluation path rather than in fetch so every request leaves
 * through the one log-and-respond frame; nothing has read the body, so the payload fields stay
 * unknown. */
async function evaluateRequest(request: Request, env: Env, log: LogFields): Promise<Outcome> {
	if (isMisrouted(request)) {
		return errorOutcome("not-found", HTTP_NOT_FOUND);
	}
	return evaluateDelivery(request, env, log);
}
/* SPEC.md §8 and §9: the one frame that maps a thrown failure onto an outcome, for the whole
 * delivery rather than the pipeline alone — reading the body and verifying the signature run
 * outside the pipeline and can reject on their own (a client disconnect or a truncated chunked
 * upload rejects request.text()). Without this the Worker would answer with the runtime's own
 * 500 and leave no log entry at all, which is the one outcome §8 does not allow. */
async function evaluateOrFail(request: Request, env: Env, log: LogFields): Promise<Outcome> {
	try {
		return await evaluateRequest(request, env, log);
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
		/* SPEC.md §9's "any other thrown failure": the bounded class name keeps configuration
		 * mistakes (e.g. a PKCS#1 key the auth library rejects) distinguishable from code bugs
		 * without touching §8's leak surface. */
		return {
			decision: "error",
			errorName: thrownErrorName(error),
			httpStatus: HTTP_INTERNAL_ERROR,
			reason: "internal-error",
		};
	}
}
/* SPEC.md §8: X-GitHub-Delivery is the only identifier GitHub's Recent Deliveries shows for a
 * failed delivery, so it is what an operator carries into the logs. It is known from the headers
 * alone, which is why every entry starts from this rather than from an empty field set. */
function deliveryFields(request: Request): LogFields {
	const log: LogFields = {};
	const deliveryId = request.headers.get("x-github-delivery");
	if (deliveryId !== null) {
		log["deliveryId"] = deliveryId;
	}
	return log;
}
/** The one terminal frame: every request leaves through exactly one log entry and one response. */
async function handleWebhook(request: Request, env: Env): Promise<Response> {
	const log = deliveryFields(request);
	const outcome = await evaluateOrFail(request, env, log);
	logOutcome(log, outcome);
	return respond(outcome);
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		return handleWebhook(request, env);
	},
} satisfies ExportedHandler<Env>;
