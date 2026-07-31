/**
 * The delivery-facing half of the Worker (src/index.ts): routing, signature verification, event
 * scoping, the body cap, and the catch-all that guarantees one log entry and one response per
 * delivery (SPEC.md §4 step 1, §8, §9). What happens once a delivery is verified and modeled is
 * driven by the pipeline suites.
 */

import {
	DELIVERY_ID,
	OVERSIZED_BODY_BYTES,
	SECRET,
	UNCHECKED_SIGNATURE,
	WEBHOOK_URL,
	buildPayload,
	captureLog,
	deliveryHeaders,
	deliveryRequest,
	dispatch,
	expectApproved,
	expectError,
	expectSkipped,
	happyRoutes,
	postSigned,
	signedDelivery,
	streamedDelivery,
	unsignedDeliveryHeaders,
} from "./delivery";
import {
	HTTP_INTERNAL_ERROR,
	HTTP_NOT_FOUND,
	HTTP_PAYLOAD_TOO_LARGE,
	HTTP_UNAUTHORIZED,
} from "~src/http-status";
import { describe, expect, it } from "vitest";
import { installFetchMock } from "./fetch-stub";
import { sign } from "@octokit/webhooks-methods";

describe("request routing", () => {
	/** The two halves of the one route check: the method, and the path (SPEC.md §9). */
	it.each([
		{ init: { method: "GET" }, name: "GET on the webhook path", url: WEBHOOK_URL },
		{
			init: { body: "{}", method: "POST" },
			name: "POST outside the webhook path",
			url: "http://example.com/other",
		},
	] as const)("returns 404 for $name", { timeout: 5000 }, async ({ init, url }) => {
		expect.hasAssertions();
		installFetchMock([]);
		await expectError(await dispatch(new Request(url, init)), "not-found", HTTP_NOT_FOUND);
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
	] as const)(
		"logs the not-found decision $name",
		{ timeout: 5000 },
		async ({ expected, headers }) => {
			expect.hasAssertions();
			const logSpy = captureLog();
			installFetchMock([]);
			await dispatch(new Request(WEBHOOK_URL, { headers, method: "GET" }));
			expect(logSpy).toHaveBeenCalledWith(expected);
		},
	);
});

describe("signature verification", () => {
	it("rejects a request without a signature header", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const request = deliveryRequest(buildPayload(), unsignedDeliveryHeaders());
		await expectError(await dispatch(request), "invalid-signature", HTTP_UNAUTHORIZED);
	});

	it("rejects a signature over a tampered body", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const signature = await sign(SECRET, buildPayload());
		const request = deliveryRequest(
			buildPayload({ action: "synchronize" }),
			deliveryHeaders(signature),
		);
		await expectError(await dispatch(request), "invalid-signature", HTTP_UNAUTHORIZED);
	});
});

describe("event scoping", () => {
	it("skips a ping event without parsing the body", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const response = await postSigned("zen text, deliberately not JSON", "ping");
		await expectSkipped(response, "event-out-of-scope");
	});

	it("skips a non-target action", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const response = await postSigned(buildPayload({ action: "closed" }));
		await expectSkipped(response, "event-out-of-scope");
	});
});

/* SPEC.md §8's `field` turns a greppable invalid-payload into a locatable one, and is the path
 * alone: the value that failed is payload content structured logs never carry (§8 warning), so
 * each row states the entry whole. A body that is not JSON locates no field, and names none. */
const INVALID_ENTRY = { decision: "error", deliveryId: DELIVERY_ID, reason: "invalid-payload" };
function namingField(field: string): Readonly<Record<string, string>> {
	const entry: Record<string, string> = { field };
	return Object.assign(entry, INVALID_ENTRY);
}

interface InvalidPayloadCase {
	readonly body: string;
	readonly entry: Readonly<Record<string, string>>;
	readonly name: string;
}

const INVALID_PAYLOADS: readonly InvalidPayloadCase[] = [
	{ body: "{not json", entry: INVALID_ENTRY, name: "a body that is not JSON" },
	{ body: '{"action":"opened"}', entry: namingField("pull_request"), name: "no pull_request" },
	{
		body: buildPayload({ headSha: { secret: "not-a-sha" } }),
		entry: namingField("pull_request.head.sha"),
		name: "a head sha of the wrong shape",
	},
];

describe("payload validation", () => {
	it.each(INVALID_PAYLOADS)("errors on $name", { timeout: 5000 }, async ({ body, entry }) => {
		expect.hasAssertions();
		const logSpy = captureLog();
		installFetchMock([]);
		await expectError(await postSigned(body), "invalid-payload", HTTP_INTERNAL_ERROR);
		expect(logSpy).toHaveBeenCalledWith(entry);
	});

	it("errors when the installation is absent", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const session = installFetchMock([]);
		const response = await postSigned(buildPayload({ installation: null }));
		await expectError(response, "missing-installation", HTTP_INTERNAL_ERROR);
		session.assertDone();
	});
});

/** A signed delivery declaring an explicit Content-Length, which postSigned leaves unset. */
async function postSignedWithLength(body: string, contentLength: number): Promise<Response> {
	return dispatch(await signedDelivery(body, { "content-length": String(contentLength) }));
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
	it(
		"rejects a Content-Length above the 25 MB webhook cap before reading the body",
		{ timeout: 5000 },
		async () => {
			expect.hasAssertions();
			const session = installFetchMock([]);
			const response = await postSignedWithLength(buildPayload(), OVERSIZED_BODY_BYTES);
			await expectError(response, "payload-too-large", HTTP_PAYLOAD_TOO_LARGE);
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
