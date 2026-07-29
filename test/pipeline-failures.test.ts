/**
 * What a delivery does when the GitHub side fails (SPEC.md §9): a private key the auth library
 * rejects, a token that cannot be issued, and a call that fails or never lands. Every one of them
 * has to answer with a non-2xx so the delivery is loud in Recent Deliveries and redeliverable, and
 * leave a log entry whose diagnostic is bounded to the endpoint, the status, or the error class —
 * never a message that could carry anything (§8).
 */

import {
	COMMITS_SUFFIX,
	HTTP_INTERNAL_ERROR,
	HTTP_NOT_FOUND,
	ORG,
	SECRET,
	TOKEN_URL,
	buildPayload,
	expectReply,
	installTokenRoute,
	postSigned,
	pullsUrl,
} from "./delivery";
import { describe, expect, it, vi } from "vitest";
import { installFetchMock, jsonRoute } from "./fetch-stub";

/** The PKCS#1 PEM shape GitHub serves, which the auth library rejects at import (SPEC.md §7). */
const PKCS1_KEY_ENV: Env = {
	GITHUB_APP_ID: "12345",
	GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n",
	GITHUB_WEBHOOK_SECRET: SECRET,
};

describe("auth configuration failures", () => {
	it("errors with a bounded diagnostic when the private key is rejected", async () => {
		expect.hasAssertions();
		const logSpy = vi.spyOn(console, "log");
		const session = installFetchMock([]);
		const response = await postSigned(buildPayload(), "pull_request", PKCS1_KEY_ENV);
		await expectReply(response, {
			body: { decision: "error", reason: "internal-error" },
			status: HTTP_INTERNAL_ERROR,
		});
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({ errorName: "Error", reason: "internal-error" }),
		);
		logSpy.mockRestore();
		session.assertDone();
	});

	it("errors loudly when the installation token cannot be issued", async () => {
		expect.hasAssertions();
		const logSpy = vi.spyOn(console, "log");
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
			expect.objectContaining({
				endpoint: "POST /app/installations/{installation_id}/access_tokens",
				status: HTTP_NOT_FOUND,
			}),
		);
		logSpy.mockRestore();
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
