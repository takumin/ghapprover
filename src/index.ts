/**
 * Worker entry point: the delivery-facing half of SPEC.md §4 — bounding and reading the body,
 * verifying the signature, and routing whatever the pipeline (src/pipeline.ts) returns into the one
 * log entry (src/log.ts, §8) and the one response (§9) every request leaves through. Processing is
 * synchronous (no ctx.waitUntil), so every outcome is recorded as-is in GitHub's Recent
 * Deliveries and redeliverable (§9).
 */

import { SIGNATURE_HEADER, verifyWebhookSignature } from "./webhook";
import { deliveryFields, logOutcome, recordPayload } from "./log";
import { errorOutcome, internalErrorOutcome, skippedOutcome } from "./outcome";
import { parsePullRequestEventBody, runPipeline } from "./pipeline";
import type { AppCredentials } from "./client";
import type { LogFields } from "./log";
import type { Outcome } from "./outcome";

/**
 * GitHub caps webhook payloads at 25 MB, so anything larger is not a delivery
 * this Worker could act on. The HMAC covers the raw body, so the body must be
 * buffered before the caller can be authenticated (SPEC.md §4 step 1), and this
 * is the cap on what an unauthenticated caller on the public endpoint can make
 * the Worker hold in memory and hash. Exported for the suite that drives the
 * bound, which states the oversized body as one byte past it rather than as a
 * literal of its own — a literal would keep passing as a body within the cap if
 * this changed.
 */
const MAX_BODY_BYTES = 26_214_400;

function respond(outcome: Outcome): Response {
	const { decision, httpStatus: status, reason } = outcome;
	if (reason === undefined) {
		return Response.json({ decision }, { status });
	}
	return Response.json({ decision, reason }, { status });
}

/* SPEC.md §7: the Workers binding is unpacked at this seam and nowhere deeper — the webhook secret
 * below and the App credentials here — so the pipeline is handed the §7 credential contract rather
 * than the platform binding it would otherwise have to reach through. */
function appCredentials(env: Env): AppCredentials {
	return { appId: env.GITHUB_APP_ID, privateKeyPem: env.GITHUB_APP_PRIVATE_KEY };
}
/**
 * A body that cannot be modeled means the evaluation could not be completed (SPEC.md §9). The
 * entry carries §8's `field` with it — the dot path of what failed and never the value there,
 * which is webhook payload content structured logs do not carry (§8 warning).
 */
async function evaluateBody(body: string, env: Env, log: LogFields): Promise<Outcome> {
	const { field, payload } = parsePullRequestEventBody(body);
	if (!payload) {
		return errorOutcome("invalid-payload", { field });
	}
	recordPayload(log, payload);
	const outcome = await runPipeline(payload, appCredentials(env));
	return outcome;
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
 * The stream decoded as text, or nothing as soon as it passes the cap — the count is
 * what actually bounds the read, so it stops there instead of after the fact, and
 * returning from the loop cancels the stream rather than draining the rest.
 * Decoding matches Request.text(): invalid UTF-8 becomes U+FFFD, which then fails
 * the HMAC, so the bound is all that changes about how the body is read.
 */
async function readCappedStream(stream: ReadableStream<Uint8Array>): Promise<string | undefined> {
	const decoder = new TextDecoder();
	let read = 0;
	let body = "";
	for await (const chunk of stream) {
		read += chunk.byteLength;
		if (read > MAX_BODY_BYTES) {
			return undefined;
		}
		body += decoder.decode(chunk, { stream: true });
	}
	return body + decoder.decode();
}
/**
 * The delivery body, or nothing when it exceeds the cap (SPEC.md §9). A declared length
 * over the cap is rejected before a byte is buffered, but it cannot be the bound: it
 * is absent on a chunked upload, and the same unauthenticated caller decides whether
 * to send it at all. The byte count is the bound; this header only saves the read.
 */
async function readBoundedBody(request: Request): Promise<string | undefined> {
	if (exceedsBodyLimit(request.headers.get("content-length"))) {
		return undefined;
	}
	/* Request.body is ReadableStream<any> in the Workers types; the runtime yields chunks
	 * of bytes, which is what the cap counts and the decoder consumes. */
	const stream: ReadableStream<Uint8Array> | null = request.body;
	if (stream === null) {
		return "";
	}
	const body = await readCappedStream(stream);
	return body;
}
/** SPEC.md §4 step 1 and §9: verify the signature and scope the event before parsing the body. */
async function evaluateDelivery(request: Request, env: Env, log: LogFields): Promise<Outcome> {
	const body = await readBoundedBody(request);
	/* Compared rather than tested for truth: an empty body is a body, and it still has to be
	 * signature-verified and parsed like any other. */
	if (body === undefined) {
		return errorOutcome("payload-too-large");
	}
	const verified = await verifyWebhookSignature(
		env.GITHUB_WEBHOOK_SECRET,
		body,
		request.headers.get(SIGNATURE_HEADER),
	);
	if (!verified) {
		return errorOutcome("invalid-signature");
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
/* SPEC.md §8 and §9: the one frame that maps a thrown failure onto an outcome, for the whole
 * delivery rather than the pipeline alone — reading the body and verifying the signature run
 * outside the pipeline and can reject on their own (a client disconnect or a truncated chunked
 * upload rejects request.text()). Without this the Worker would answer with the runtime's own
 * 500 and leave no log entry at all, which is the one outcome §8 does not allow. */
async function evaluateOrFail(request: Request, env: Env, log: LogFields): Promise<Outcome> {
	try {
		/* SPEC.md §8: the reason vocabulary is what an operator greps, and a webhook URL pointing at
		 * the wrong path is exactly what not-found exists to surface — so it has to leave a log entry,
		 * not only a 404 body. Settled on the evaluation path rather than in fetch so every request
		 * leaves through the one log-and-respond frame; nothing has read the body, so the payload
		 * fields stay unknown. */
		if (isMisrouted(request)) {
			return errorOutcome("not-found");
		}
		return await evaluateDelivery(request, env, log);
	} catch (error) {
		/* SPEC.md §9's "any other thrown failure". A failed GitHub call is not one of these:
		 * runPipeline maps its own GithubApiError onto the github-api-error outcome, with the §8
		 * diagnostics that error carries. */
		return internalErrorOutcome(error);
	}
}
/** The one terminal frame: every request leaves through exactly one log entry and one response. */
async function handleWebhook(request: Request, env: Env): Promise<Response> {
	const log = deliveryFields(request);
	const outcome = await evaluateOrFail(request, env, log);
	logOutcome(log, outcome);
	return respond(outcome);
}

export { MAX_BODY_BYTES };

// oxlint-disable-next-line import/no-default-export -- the Workers runtime takes its handler as the module's default export
export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const response = await handleWebhook(request, env);
		return response;
	},
} satisfies ExportedHandler<Env>;
