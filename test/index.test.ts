/**
 * What src/index.ts decides about a delivery once its bytes have been read: the one route check,
 * signature verification, event scoping, and the payload the pipeline is only handed if it models
 * (SPEC.md §4 step 1, §8, §9), and the frame all of that decides inside. The read that produces
 * those bytes, cap and all, is index-body's; what happens once a delivery is verified and modeled
 * is driven by the pipeline suites.
 */

import {
	DELIVERY_ID,
	OVERSIZED_BODY_BYTES,
	SECRET,
	UNCHECKED_SIGNATURE,
	VERSION_ID,
	WEBHOOK_URL,
	buildPayload,
	captureLog,
	deliveryHeaders,
	deliveryRequest,
	dispatch,
	expectError,
	expectSkipped,
	makeEnv,
	makeEnvWithoutVersionMetadata,
	makeEnvWithoutWebhookSecret,
	postSigned,
	unsignedDeliveryHeaders,
} from "./delivery";
import { HTTP_INTERNAL_ERROR, HTTP_NOT_FOUND, HTTP_UNAUTHORIZED } from "~src/http-status";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_DELIVERY_ID_CHARS } from "~src/log";
import { installFetchMock } from "./fetch-stub";
import { resetAppBotLogin } from "~src/github";
import { sign } from "@octokit/webhooks-methods";

/* Every case below plans no route at all, because a delivery turned away here reaches no GitHub
 * call — and the App login is cached for the isolate (SPEC.md §4), so a case that wrongly did
 * reach for it could be served from an earlier run rather than caught. The state is the module's,
 * so is the hook. */
// oxlint-disable-next-line vitest/no-hooks, vitest/require-top-level-describe -- see above
beforeEach(resetAppBotLogin);

/* SPEC.md §8: the version id comes off the binding rather than the request, so no rejection is
 * early enough to lack it, and the severity is `error` for every case below — each is an evaluation
 * that could not be completed, which is the half of the vocabulary filed that way (log.test.ts
 * covers the rest). Stated once, leaving each case to name its own fields and override these. */
function loggedEntry(fields: Readonly<Record<string, string>>): Record<string, string> {
	const entry: Record<string, string> = { level: "error", versionId: VERSION_ID };
	return Object.assign(entry, fields);
}

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
			expect(logSpy).toHaveBeenCalledWith(loggedEntry(expected));
		},
	);
});

/* SPEC.md §8: the same header read as above, driven for its bound rather than its presence. A
 * misrouted GET is the cheapest way to reach it with nothing authenticated — no route check, no
 * webhook secret and no signature has been consulted by the time the field is on the entry, so
 * the length of what lands there is the caller's to pick unless the entry bounds it. */
describe("delivery id bound", () => {
	/* Stated as the bound plus one rather than as a length of its own: a literal would keep passing
	 * as a value within the bound once that bound moved, which is the case this is here to hold. */
	it("truncates a delivery id past the bound", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const logSpy = captureLog();
		installFetchMock([]);
		const overlong = "d".repeat(MAX_DELIVERY_ID_CHARS + 1);
		const headers = { "x-github-delivery": overlong };
		await dispatch(new Request(WEBHOOK_URL, { headers, method: "GET" }));
		expect(logSpy).toHaveBeenCalledWith(
			loggedEntry({
				decision: "error",
				deliveryId: overlong.slice(0, MAX_DELIVERY_ID_CHARS),
				reason: "not-found",
			}),
		);
	});
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

/* SPEC.md §8: a deployment that never had a webhook secret rejects every delivery, and what the
 * entry has to say is which of the two secrets called "the webhook secret" is at fault — the one on
 * the App, or this Worker's own. Every case here signs correctly where it signs at all, so what is
 * being driven is the deployment and never the digest. */
describe("webhook secret configuration", () => {
	it("errors when the secret binding is absent", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const logSpy = captureLog();
		const session = installFetchMock([]);
		const env = await makeEnvWithoutWebhookSecret();
		const response = await postSigned(buildPayload(), "pull_request", env);
		await expectError(response, "missing-webhook-secret", HTTP_INTERNAL_ERROR);
		expect(logSpy).toHaveBeenCalledExactlyOnceWith(
			loggedEntry({
				decision: "error",
				deliveryId: DELIVERY_ID,
				reason: "missing-webhook-secret",
			}),
		);
		session.assertDone();
	});

	/* The other shape an unconfigured secret takes, and the one the binding's declared type does
	 * admit: verify() refuses it exactly as it refuses the absent one, so it is the same outcome. */
	it("errors when the secret is empty", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const session = installFetchMock([]);
		const env = await makeEnv({ GITHUB_WEBHOOK_SECRET: "" });
		const response = await postSigned(buildPayload(), "pull_request", env);
		await expectError(response, "missing-webhook-secret", HTTP_INTERNAL_ERROR);
		session.assertDone();
	});
});

/* What an unconfigured deployment answers a delivery that would have been turned away on its own
 * terms anyway. The secret is settled before the signature header is looked at and before a byte of
 * the body is read (SPEC.md §4), which is what makes the outcome the answer to every delivery such
 * a deployment receives rather than to the ones that happened to arrive well-formed and within the
 * cap — the others would name the delivery for a fault that is the deployment's. */
interface RefusedCase {
	readonly headers: Readonly<Record<string, string>>;
	readonly name: string;
}

const OTHERWISE_REFUSED: readonly RefusedCase[] = [
	{ headers: unsignedDeliveryHeaders(), name: "a delivery carrying no signature" },
	{
		headers: Object.assign(deliveryHeaders(UNCHECKED_SIGNATURE), {
			"content-length": String(OVERSIZED_BODY_BYTES),
		}),
		name: "a body declared over the cap",
	},
];

describe("webhook secret precedence", () => {
	it.each(OTHERWISE_REFUSED)(
		"reports the absent secret over $name",
		{ timeout: 5000 },
		async ({ headers }) => {
			expect.hasAssertions();
			const session = installFetchMock([]);
			const request = deliveryRequest(buildPayload(), headers);
			const response = await dispatch(request, await makeEnvWithoutWebhookSecret());
			await expectError(response, "missing-webhook-secret", HTTP_INTERNAL_ERROR);
			session.assertDone();
		},
	);
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
		expect(logSpy).toHaveBeenCalledWith(loggedEntry(entry));
	});

	it("errors when the installation is absent", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const session = installFetchMock([]);
		const response = await postSigned(buildPayload({ installation: null }));
		await expectError(response, "missing-installation", HTTP_INTERNAL_ERROR);
		session.assertDone();
	});
});

/* The runtime's own wording for a property read on nothing, which is not this Worker's to state:
 * the entry has to carry a message, and which one is workerd's business. Typed as `unknown` at the
 * matcher rather than at its use, `expect.any` being untyped where the entry below is not. */
const ANY_MESSAGE: unknown = expect.any(String);

describe("the terminal frame", () => {
	/* SPEC.md §8 asks for one entry per delivery, and the fields of the entry itself are inside
	 * what that has to hold for: `versionId` is read off the §5 binding, so a deployment that
	 * dropped it makes the read throw. Derived ahead of the frame the throw escaped `fetch` and the
	 * delivery ended as the runtime's own 500 with nothing logged — the one outcome §8 does not
	 * allow, and the only one nothing here observed. What survives is not the field but the entry:
	 * the delivery id read just before the throw, and the class that threw. */
	it("logs one entry when the version binding is absent", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const logSpy = captureLog();
		const session = installFetchMock([]);
		const env = await makeEnvWithoutVersionMetadata();
		const response = await postSigned(buildPayload(), "pull_request", env);
		await expectError(response, "internal-error", HTTP_INTERNAL_ERROR);
		/* Exactly once and with exactly this: one entry is half of what §8 asks for here, and an
		 * entry stated whole rather than contained is what says the field that threw is absent
		 * from it rather than merely unasserted. */
		expect(logSpy).toHaveBeenCalledExactlyOnceWith({
			decision: "error",
			deliveryId: DELIVERY_ID,
			errorMessage: ANY_MESSAGE,
			errorName: "TypeError",
			level: "error",
			reason: "internal-error",
		});
		session.assertDone();
	});
});
