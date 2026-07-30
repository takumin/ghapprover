/**
 * The delivery-facing half of the Worker (src/index.ts): routing, signature verification, event
 * scoping, the body cap, and the catch-all that guarantees one log entry and one response per
 * delivery (SPEC.md §4 step 1, §8, §9). What happens once a delivery is verified and modeled is
 * driven by the pipeline suites.
 */

import {
	DELIVERY_ID,
	HTTP_INTERNAL_ERROR,
	HTTP_NOT_FOUND,
	HTTP_OK,
	HTTP_PAYLOAD_TOO_LARGE,
	HTTP_UNAUTHORIZED,
	OVERSIZED_BODY_BYTES,
	SECRET,
	UNCHECKED_SIGNATURE,
	WEBHOOK_URL,
	buildPayload,
	deliveryHeaders,
	dispatch,
	expectReply,
	happyRoutes,
	postSigned,
	streamedDelivery,
} from "./delivery";
import { describe, expect, it, vi } from "vitest";
import { installFetchMock } from "./fetch-stub";
import { sign } from "@octokit/webhooks-methods";

describe("request routing", () => {
	it("returns 404 for GET on the webhook path", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const response = await dispatch(new Request(WEBHOOK_URL, { method: "GET" }));
		await expectReply(response, {
			body: { decision: "error", reason: "not-found" },
			status: HTTP_NOT_FOUND,
		});
	});

	it("returns 404 for POST outside the webhook path", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const request = new Request("http://example.com/other", { body: "{}", method: "POST" });
		await expectReply(await dispatch(request), {
			body: { decision: "error", reason: "not-found" },
			status: HTTP_NOT_FOUND,
		});
	});

	/* SPEC.md §8: a webhook URL pointing at the wrong path is what not-found exists to
	 * surface, so the 404 has to be greppable in the logs, not only in the response body —
	 * and greppable by the delivery id, which is all GitHub's Recent Deliveries shows the
	 * operator for a failed delivery. The header carries it even on a request nothing reads
	 * the body of. */
	it.each([
		{
			expected: { decision: "error", deliveryId: DELIVERY_ID, reason: "not-found" },
			headers: { "x-github-delivery": DELIVERY_ID },
			name: "carrying the delivery id",
		},
		{
			expected: { decision: "error", reason: "not-found" },
			headers: {},
			name: "without a delivery id header",
		},
	])("logs the not-found decision $name", async ({ expected, headers }) => {
		expect.hasAssertions();
		const logSpy = vi.spyOn(console, "log");
		installFetchMock([]);
		await dispatch(new Request(WEBHOOK_URL, { headers, method: "GET" }));
		expect(logSpy).toHaveBeenCalledWith(expected);
		logSpy.mockRestore();
	});
});

describe("signature verification", () => {
	it("rejects a request without a signature header", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const request = new Request(WEBHOOK_URL, {
			body: buildPayload(),
			headers: { "x-github-delivery": DELIVERY_ID, "x-github-event": "pull_request" },
			method: "POST",
		});
		await expectReply(await dispatch(request), {
			body: { decision: "error", reason: "invalid-signature" },
			status: HTTP_UNAUTHORIZED,
		});
	});

	it("rejects a signature over a tampered body", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const signature = await sign(SECRET, buildPayload());
		const request = new Request(WEBHOOK_URL, {
			body: buildPayload({ action: "synchronize" }),
			headers: {
				"x-github-delivery": DELIVERY_ID,
				"x-github-event": "pull_request",
				"x-hub-signature-256": signature,
			},
			method: "POST",
		});
		await expectReply(await dispatch(request), {
			body: { decision: "error", reason: "invalid-signature" },
			status: HTTP_UNAUTHORIZED,
		});
	});
});

describe("event scoping", () => {
	it("skips a ping event without parsing the body", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const response = await postSigned("zen text, deliberately not JSON", "ping");
		await expectReply(response, {
			body: { decision: "skipped", reason: "event-out-of-scope" },
			status: HTTP_OK,
		});
	});

	it("skips a non-target action", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const response = await postSigned(buildPayload({ action: "closed" }));
		await expectReply(response, {
			body: { decision: "skipped", reason: "event-out-of-scope" },
			status: HTTP_OK,
		});
	});
});

describe("payload validation", () => {
	it("errors on a non-JSON pull_request body", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const response = await postSigned("{not json");
		await expectReply(response, {
			body: { decision: "error", reason: "invalid-payload" },
			status: HTTP_INTERNAL_ERROR,
		});
	});

	it("errors on a payload missing pull_request fields", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const response = await postSigned('{"action":"opened"}');
		await expectReply(response, {
			body: { decision: "error", reason: "invalid-payload" },
			status: HTTP_INTERNAL_ERROR,
		});
	});

	it("errors when the installation is absent", async () => {
		expect.hasAssertions();
		const session = installFetchMock([]);
		const response = await postSigned(buildPayload({ installation: null }));
		await expectReply(response, {
			body: { decision: "error", reason: "missing-installation" },
			status: HTTP_INTERNAL_ERROR,
		});
		session.assertDone();
	});
});

/** A signed delivery declaring an explicit Content-Length, which postSigned leaves unset. */
async function postSignedWithLength(body: string, contentLength: number): Promise<Response> {
	const headers = deliveryHeaders(await sign(SECRET, body));
	headers["content-length"] = String(contentLength);
	return dispatch(new Request(WEBHOOK_URL, { body, headers, method: "POST" }));
}

/* A chunked upload carries no Content-Length, so the declared-length check cannot see it and
 * the running byte count is what has to stop the read. Chunks are produced on demand, so the
 * stream is cancelled at the cap instead of the test handing over the whole oversized body. */
const CHUNK_BYTES = 4_194_304;
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
	it("rejects a Content-Length above the 25 MB webhook cap before reading the body", async () => {
		expect.hasAssertions();
		const session = installFetchMock([]);
		const response = await postSignedWithLength(buildPayload(), OVERSIZED_BODY_BYTES);
		await expectReply(response, {
			body: { decision: "error", reason: "payload-too-large" },
			status: HTTP_PAYLOAD_TOO_LARGE,
		});
		expect(session.requests).toHaveLength(0);
	});

	it("processes a delivery whose Content-Length is within the cap", async () => {
		expect.hasAssertions();
		installFetchMock(happyRoutes());
		const body = buildPayload();
		const response = await postSignedWithLength(body, new TextEncoder().encode(body).length);
		await expectReply(response, { body: { decision: "approved" }, status: HTTP_OK });
	});

	/* The case the declared length cannot cover: an unauthenticated caller streams a body past
	 * the cap, and without the byte count the Worker would buffer and hash all of it. */
	it("rejects a chunked body past the cap, which declares no Content-Length", async () => {
		expect.hasAssertions();
		const session = installFetchMock([]);
		await expectReply(await dispatch(oversizedChunkedRequest()), {
			body: { decision: "error", reason: "payload-too-large" },
			status: HTTP_PAYLOAD_TOO_LARGE,
		});
		expect(session.requests).toHaveLength(0);
	});

	/* The signature is computed over the whole body, so an approval here is what proves the
	 * chunked read reassembles it exactly rather than merely bounding it. */
	it("processes a chunked delivery within the cap", async () => {
		expect.hasAssertions();
		installFetchMock(happyRoutes());
		await expectReply(await postSignedChunked(buildPayload()), {
			body: { decision: "approved" },
			status: HTTP_OK,
		});
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
	it("errors with the thrown class and message when the body cannot be read", async () => {
		expect.hasAssertions();
		const logSpy = vi.spyOn(console, "log");
		const session = installFetchMock([]);
		await expectReply(await dispatch(requestWithFailingBody()), {
			body: { decision: "error", reason: "internal-error" },
			status: HTTP_INTERNAL_ERROR,
		});
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				decision: "error",
				deliveryId: DELIVERY_ID,
				errorMessage: "connection reset",
				errorName: "TypeError",
				reason: "internal-error",
			}),
		);
		logSpy.mockRestore();
		session.assertDone();
	});
});
