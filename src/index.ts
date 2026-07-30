/**
 * Worker entry point: the delivery-facing half of SPEC.md §4 — bounding and reading the body,
 * verifying the signature, and turning whatever the pipeline (src/pipeline.ts) returns into the
 * one log entry (§8) and the one response (§9) every request leaves through. Processing is
 * synchronous (no ctx.waitUntil), so every outcome is recorded as-is in GitHub's Recent
 * Deliveries and redeliverable (§9).
 */

import { errorOutcome, runPipeline, skippedOutcome } from "./pipeline";
import { GithubApiError } from "./client";
import type { Outcome } from "./pipeline";
import type { PullRequestEventPayload } from "./types";
import { parsePullRequestEvent } from "./payload";
import { verifyWebhookSignature } from "./webhook";

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

/** SPEC.md §8 flat log entry, accumulating fields as they become known per delivery. */
type LogFields = Record<string, number | string>;

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
/** The §8 fields an outcome carries only for the outcomes they apply to, in that table's order; httpStatus is not logged. */
const OPTIONAL_LOG_FIELDS = [
	"reason",
	"endpoint",
	"status",
	"requestId",
	"acceptedPermissions",
	"rateLimitRemaining",
	"rateLimitReset",
	"errorName",
] as const;
/**
 * The one bound on the one §8 field that has none at its source: @octokit/request
 * builds an error message from the response body and takes the whole body when
 * that body is not JSON (an HTML error page from GitHub or a proxy in front of
 * it). Truncating here, where the entry is built, is what makes it one rule for
 * every path onto the field rather than one per place an error is raised
 * (SPEC.md §12).
 */
const MAX_ERROR_MESSAGE_CHARS = 512;
/** Exactly one structured log entry per handled webhook delivery (SPEC.md §8). */
function logOutcome(log: LogFields, outcome: Outcome): void {
	log["decision"] = outcome.decision;
	for (const key of OPTIONAL_LOG_FIELDS) {
		const value = outcome[key];
		if (value !== undefined) {
			log[key] = value;
		}
	}
	const { errorMessage } = outcome;
	if (errorMessage !== undefined) {
		log["errorMessage"] = errorMessage.slice(0, MAX_ERROR_MESSAGE_CHARS);
	}
	console.log(log);
}

/** The thrown value's class name, which stays bounded whatever was thrown (§8). */
function thrownErrorName(error: unknown): string {
	if (error instanceof Error) {
		return error.name;
	}
	return "unknown";
}
/* §8 pairs the class name with the message the thrown value carries, truncated with every other
 * path onto that field above. A value thrown that is not an Error has no message to report — the
 * class name already says so — so the field is left off rather than filled with a stringification
 * of whatever it was. */
function thrownErrorMessage(error: unknown): string | undefined {
	if (error instanceof Error) {
		return error.message;
	}
	return undefined;
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
			/* SPEC.md §9: keep status and endpoint so 401/403 configuration problems are
			 * distinguishable in logs, and the §8 diagnostics with them — status alone does not say
			 * whether a 403 was a missing permission or a rate limit, which is the distinction §9
			 * asks for. They are absent when the failure carried no response to read them from. */
			const { acceptedPermissions, errorMessage, rateLimitRemaining, rateLimitReset, requestId } =
				error.diagnostics;
			return {
				acceptedPermissions,
				decision: "error",
				endpoint: error.endpoint,
				errorMessage,
				httpStatus: HTTP_INTERNAL_ERROR,
				rateLimitRemaining,
				rateLimitReset,
				reason: "github-api-error",
				requestId,
				status: error.status,
			};
		}
		/* SPEC.md §9's "any other thrown failure": the class name keeps configuration mistakes
		 * (e.g. a PKCS#1 key the auth library rejects) distinguishable from code bugs, and §8's
		 * errorMessage is what says which mistake it was — the class alone is `Error` for both. */
		return {
			decision: "error",
			errorMessage: thrownErrorMessage(error),
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
