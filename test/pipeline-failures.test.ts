/**
 * What a delivery does when the GitHub side fails (SPEC.md §9): a private key the auth library
 * rejects, a token that cannot be issued, and a call that fails or never lands. Every one of them
 * has to answer with a non-2xx so the delivery is loud in Recent Deliveries and redeliverable, and
 * leave a log entry saying which failure it was: the endpoint, the status, the error class, the
 * response headers that separate a permission problem from a rate limit, and the originating
 * message — the one unbounded field, truncated where the entry is built (§8, §12).
 */

import {
	COMMITS_ENDPOINT,
	HTTP_FORBIDDEN,
	HTTP_INTERNAL_ERROR,
	HTTP_NOT_FOUND,
	PULL_NUMBER,
	REFUSAL_HEADERS,
	TOKEN_ENDPOINT,
	installFetchMock,
	jsonRoute,
} from "./fetch-stub";
import {
	COMMITS_SUFFIX,
	DELIVERY_ID,
	HEAD_SHA,
	TOKEN_URL,
	buildPayload,
	captureLog,
	expectReply,
	installTokenRoute,
	makeEnv,
	postSigned,
	pullsUrl,
} from "./delivery";
import { describe, expect, it } from "vitest";
import { ORG } from "./accounts";
import type { PlannedRoute } from "./fetch-stub";

/** What the auth library says about that key, and what §8's errorMessage exists to carry into the entry. */
const PKCS1_MESSAGE =
	"[universal-github-app-jwt] Private Key is in PKCS#1 format, but only PKCS#8 is supported. See https://github.com/gr2m/universal-github-app-jwt#private-key-formats";
/** The PKCS#1 PEM shape GitHub serves, which the auth library rejects at import (SPEC.md §7). */
const PKCS1_PEM = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n";

describe("auth configuration failures", () => {
	it("errors with a bounded diagnostic when the private key is rejected", async () => {
		expect.hasAssertions();
		const logSpy = captureLog();
		const session = installFetchMock([]);
		const env = await makeEnv({ GITHUB_APP_PRIVATE_KEY: PKCS1_PEM });
		const response = await postSigned(buildPayload(), "pull_request", env);
		await expectReply(response, {
			body: { decision: "error", reason: "internal-error" },
			status: HTTP_INTERNAL_ERROR,
		});
		/* SPEC.md §8: the class name is `Error` for every configuration mistake alike, so what says
		 * which one this was is the message the auth library raised. */
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				errorMessage: PKCS1_MESSAGE,
				errorName: "Error",
				reason: "internal-error",
			}),
		);
		session.assertDone();
	});

	it("errors loudly when the installation token cannot be issued", async () => {
		expect.hasAssertions();
		const logSpy = captureLog();
		const session = installFetchMock([
			jsonRoute({
				method: "POST",
				payload: { message: "Not Found" },
				status: HTTP_NOT_FOUND,
				url: TOKEN_URL,
			}),
		]);
		const response = await postSigned(buildPayload({ repoOwner: ORG }));
		await expectReply(response, {
			body: { decision: "error", reason: "github-api-error" },
			status: HTTP_INTERNAL_ERROR,
		});
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({ endpoint: TOKEN_ENDPOINT, status: HTTP_NOT_FOUND }),
		);
		session.assertDone();
	});
});

describe("github api failures", () => {
	it("errors when the commits request fails", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			installTokenRoute(),
			jsonRoute({
				method: "GET",
				payload: { message: "boom" },
				status: HTTP_INTERNAL_ERROR,
				url: pullsUrl("octo", COMMITS_SUFFIX),
			}),
		]);
		const response = await postSigned(buildPayload());
		await expectReply(response, {
			body: { decision: "error", reason: "github-api-error" },
			status: HTTP_INTERNAL_ERROR,
		});
		session.assertDone();
	});

	it("errors when the commits request hits a network failure", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			installTokenRoute(),
			jsonRoute({
				method: "GET",
				payload: {},
				status: 0,
				url: pullsUrl("octo", COMMITS_SUFFIX),
			}),
		]);
		const response = await postSigned(buildPayload());
		await expectReply(response, {
			body: { decision: "error", reason: "github-api-error" },
			status: HTTP_INTERNAL_ERROR,
		});
		session.assertDone();
	});
});

/** SPEC.md §8: the truncation bound, and a message that runs past it. */
const MESSAGE_LIMIT = 512;
const OVERLONG_MESSAGE = "boom ".repeat(MESSAGE_LIMIT);

/** The commits request is where these cases plant the failure: every full run reaches it. */
function commitsFailureRoute(
	payload: unknown,
	status: number,
	headers?: Record<string, string>,
): PlannedRoute {
	return jsonRoute({
		headers,
		method: "GET",
		payload,
		status,
		url: pullsUrl("octo", COMMITS_SUFFIX),
	});
}
/* SPEC.md §8 and §9: a github-api-error is greppable, but only these fields say which failure it
 * was. §9 asks for a 401/403 to be distinguishable in logs as a configuration problem, and it is
 * the headers that do it — status 403 alone is a missing permission and a rate limit at once. */
describe("api failure diagnostics", () => {
	it("logs what tells a refused call apart from an exhausted rate limit", async () => {
		expect.hasAssertions();
		const logSpy = captureLog();
		const session = installFetchMock([
			installTokenRoute(),
			commitsFailureRoute({ message: "API rate limit exceeded" }, HTTP_FORBIDDEN, REFUSAL_HEADERS),
		]);
		await postSigned(buildPayload());
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				acceptedPermissions: "pull_requests=write",
				endpoint: COMMITS_ENDPOINT,
				errorMessage: "API rate limit exceeded",
				rateLimitRemaining: "0",
				rateLimitReset: "1770000000",
				reason: "github-api-error",
				requestId: "F1E2:3D4C",
				status: HTTP_FORBIDDEN,
			}),
		);
		session.assertDone();
	});

	/* Asserted as the whole entry rather than a subset: what this case is about is the four fields
	 * that are *not* there, a failure with no response having no headers to read them off. */
	it("logs the message but no headers when the call never received a response", async () => {
		expect.hasAssertions();
		const logSpy = captureLog();
		const session = installFetchMock([installTokenRoute(), commitsFailureRoute({}, 0)]);
		await postSigned(buildPayload());
		expect(logSpy).toHaveBeenCalledWith({
			action: "opened",
			decision: "error",
			deliveryId: DELIVERY_ID,
			endpoint: COMMITS_ENDPOINT,
			errorMessage: "simulated network failure",
			headSha: HEAD_SHA,
			prNumber: PULL_NUMBER,
			reason: "github-api-error",
			repo: "octo/hello",
			status: 0,
		});
		session.assertDone();
	});
});

/* SPEC.md §8 and §12: @octokit/request builds the message from the response body — the whole body
 * when it is not JSON — so nothing bounds it at the source. The entry is where it is bounded,
 * which is what makes one rule cover every path onto the field. */
describe("error message bounds", () => {
	it("truncates a message the source does not bound", async () => {
		expect.hasAssertions();
		const logSpy = captureLog();
		const session = installFetchMock([
			installTokenRoute(),
			commitsFailureRoute({ message: OVERLONG_MESSAGE }, HTTP_INTERNAL_ERROR),
		]);
		await postSigned(buildPayload());
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({ errorMessage: OVERLONG_MESSAGE.slice(0, MESSAGE_LIMIT) }),
		);
		session.assertDone();
	});
});
