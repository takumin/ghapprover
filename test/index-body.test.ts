/**
 * Getting a delivery's raw bytes in hand, which is where src/index.ts sits between the route check
 * and the signature (SPEC.md §4 step 1): the 2 MiB cap, refused on a declared Content-Length before
 * a byte is buffered and on the running byte count when a chunked upload declares none (§9), and
 * the catch-all that still answers once and logs once when the body stream fails mid-read (§8).
 * Every case here is about the read itself, so the routing, signature, scoping and payload checks
 * the bytes are then put through stay with the sibling suite in index.test.ts.
 */

import {
	DELIVERY_ID,
	OVERSIZED_BODY_BYTES,
	SECRET,
	UNCHECKED_SIGNATURE,
	VERSION_ID,
	buildPayload,
	captureLog,
	dispatch,
	expectApproved,
	expectError,
	happyRoutes,
	signedDelivery,
	streamedDelivery,
} from "./delivery";
import { HTTP_INTERNAL_ERROR, HTTP_PAYLOAD_TOO_LARGE } from "~src/http-status";
import { beforeEach, describe, expect, it } from "vitest";
import { installFetchMock } from "./fetch-stub";
import { resetAppBotLogin } from "~src/github";
import { sign } from "@octokit/webhooks-methods";

/* The cases that stay within the cap run the whole delivery through, and the App login is cached
 * for the isolate (SPEC.md §4): emptied here so each of them is the run its plan describes rather
 * than one silently short a call an earlier case made. The state is the module's, so is the hook. */
// oxlint-disable-next-line vitest/no-hooks, vitest/require-top-level-describe -- see above
beforeEach(resetAppBotLogin);

/** A signed delivery declaring an explicit Content-Length, which postSigned leaves unset. */
async function postSignedWithLength(body: string, contentLength: number): Promise<Response> {
	return dispatch(await signedDelivery(body, { "content-length": String(contentLength) }));
}

/* A chunked upload carries no Content-Length, so the byte count is what has to stop the read,
 * and each chunk is a fraction of the cap so that count has to accumulate across them. Chunks
 * are produced on demand, so the stream is cancelled at the cap rather than handed over whole. */
const CHUNK_COUNT = 8;
const CHUNK_BYTES = Math.ceil(OVERSIZED_BODY_BYTES / CHUNK_COUNT);
function oversizedChunkedRequest(): Request {
	let sent = 0;
	const body = new ReadableStream({
		pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
			sent += CHUNK_BYTES;
			controller.enqueue(new Uint8Array(CHUNK_BYTES));
			if (sent > OVERSIZED_BODY_BYTES) {
				controller.close();
			}
		},
	});
	return streamedDelivery(body, UNCHECKED_SIGNATURE);
}

/** The signed payload as a stream body: no Content-Length, and split across chunk boundaries. */
const SMALL_CHUNK_BYTES = 7;
async function postSignedChunked(body: string): Promise<Response> {
	const bytes = new TextEncoder().encode(body);
	const stream = new ReadableStream({
		start(controller: ReadableStreamDefaultController<Uint8Array>): void {
			for (let at = 0; at < bytes.length; at += SMALL_CHUNK_BYTES) {
				controller.enqueue(bytes.slice(at, at + SMALL_CHUNK_BYTES));
			}
			controller.close();
		},
	});
	return dispatch(streamedDelivery(stream, await sign(SECRET, body)));
}

describe("request body limits", () => {
	it(
		"rejects a Content-Length above the body cap before reading the body",
		{ timeout: 5000 },
		async () => {
			expect.hasAssertions();
			const logSpy = captureLog();
			const session = installFetchMock([]);
			const response = await postSignedWithLength(buildPayload(), OVERSIZED_BODY_BYTES);
			await expectError(response, "payload-too-large", HTTP_PAYLOAD_TOO_LARGE);
			/* The rejection no payload field survives: the version id still does, having never
			 * depended on the body this delivery was refused before reading (SPEC.md §8). */
			expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ versionId: VERSION_ID }));
			expect(session.requests).toHaveLength(0);
		},
	);

	it("processes a delivery whose Content-Length is within the cap", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		installFetchMock(happyRoutes());
		const body = buildPayload();
		const response = await postSignedWithLength(body, new TextEncoder().encode(body).length);
		await expectApproved(response);
	});

	/* The case the declared length cannot cover: an unauthenticated caller streams a body past
	 * the cap, and without the byte count the Worker would buffer and hash all of it. */
	it(
		"rejects a chunked body past the cap, which declares no Content-Length",
		{ timeout: 5000 },
		async () => {
			expect.hasAssertions();
			const session = installFetchMock([]);
			await expectError(
				await dispatch(oversizedChunkedRequest()),
				"payload-too-large",
				HTTP_PAYLOAD_TOO_LARGE,
			);
			expect(session.requests).toHaveLength(0);
		},
	);

	/* The signature is computed over the whole body, so an approval here is what proves the
	 * chunked read reassembles it exactly rather than merely bounding it. */
	it("processes a chunked delivery within the cap", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		installFetchMock(happyRoutes());
		await expectApproved(await postSignedChunked(buildPayload()));
	});
});

/* A body whose stream errors mid-read: what a client disconnect or a truncated chunked upload
 * looks like to the Worker. */
function requestWithFailingBody(): Request {
	const body = new ReadableStream({
		start(controller: ReadableStreamDefaultController<Uint8Array>): void {
			controller.error(new TypeError("connection reset"));
		},
	});
	return streamedDelivery(body, UNCHECKED_SIGNATURE);
}

describe("unreadable deliveries", () => {
	/* SPEC.md §8 requires one log entry per delivery and §9 maps any other thrown failure to
	 * internal-error. Reading the body runs before the pipeline's own guard, so without a
	 * catch-all this delivery would answer with the runtime's 500 and log nothing at all. The
	 * entry carries the §8 pair for a failure that is nobody's endpoint: the class name, and the
	 * message that says which failure of that class it was. */
	it(
		"errors with the thrown class and message when the body cannot be read",
		{ timeout: 5000 },
		async () => {
			expect.hasAssertions();
			const logSpy = captureLog();
			const session = installFetchMock([]);
			await expectError(
				await dispatch(requestWithFailingBody()),
				"internal-error",
				HTTP_INTERNAL_ERROR,
			);
			expect(logSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					decision: "error",
					deliveryId: DELIVERY_ID,
					errorMessage: "connection reset",
					errorName: "TypeError",
					reason: "internal-error",
				}),
			);
			session.assertDone();
		},
	);
});
