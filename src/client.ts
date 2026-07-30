/**
 * The per-delivery GitHub client and the error contract every call maps onto
 * (SPEC.md §11): @octokit/core issues the requests, @octokit/plugin-paginate-rest
 * follows the Link header for pagination, and @octokit/auth-app signs the App JWT
 * and issues installation tokens (cached in memory per client, SPEC.md §7). Split
 * from the endpoint module (src/github.ts) so that what every call shares — the
 * client, the delivery budget, and the failure mapping — stays apart from what
 * each endpoint maps for itself.
 */

import { Octokit } from "@octokit/core";
import { RequestError } from "@octokit/request-error";
import { createAppAuth } from "@octokit/auth-app";
import { paginateRest } from "@octokit/plugin-paginate-rest";

const API_VERSION = "2022-11-28";
const USER_AGENT = "ghapprover";
/**
 * Whole-delivery budget, shared by every call the client makes (SPEC.md §4;
 * §9: no retries inside the Worker, but a deadline on every call). Without it
 * a delivery could outlive GitHub's 10-second webhook timeout and land an
 * approval whose delivery is recorded as failed, so it is set below that
 * timeout to leave room for the signature check and the response. A
 * per-dispatch budget on top would never bind: it starts at or after this one,
 * so it could only fire first by being shorter than the whole delivery — which
 * is this budget again.
 *
 * The value also absorbs the one thing the signal cannot abort: @octokit/auth-app
 * waits between its 401 retries on a plain timer, so a wait in flight when this
 * expires runs to its end before the next dispatch aborts. Only one can be in
 * flight (that dispatch fails as a timeout rather than a 401, which ends the
 * retry loop), so the overrun is bounded by the longest single wait, 3 s. Hence
 * 6 s: 6 + 3 clears the 10-second timeout with room for the body read, the HMAC,
 * and the response (SPEC.md §4, §9).
 */
const DELIVERY_TIMEOUT_MS = 6000;
/** GithubApiError status representing network-level failures and timeouts. */
const NETWORK_FAILURE_STATUS = 0;

const GithubOctokit = Octokit.plugin(paginateRest);

/** Per-delivery client with App auth and Link-header pagination wired in. */
export type GithubClient = InstanceType<typeof GithubOctokit>;

export interface AppCredentials {
	/** GitHub App ID (or client ID), the `iss` claim of the App JWT. */
	readonly appId: string;
	/** GitHub App private key PEM, converted to PKCS#8 (SPEC.md §7). */
	readonly privateKeyPem: string;
}

/**
 * Error for failed GitHub API calls. The endpoint is the "METHOD /path"
 * route template only; the message is built solely from that and a fixed
 * reason — never a token, a query string, or a response body excerpt
 * (SPEC.md §8 warning).
 */
export class GithubApiError extends Error {
	public readonly endpoint: string;
	public readonly status: number;

	public constructor(endpoint: string, status: number, reason: string) {
		super(`GitHub API call ${endpoint} failed (status ${status}): ${reason}`);
		this.name = "GithubApiError";
		this.endpoint = endpoint;
		this.status = status;
	}
}

export function shapeError(endpoint: string, status: number): GithubApiError {
	return new GithubApiError(endpoint, status, "unexpected response shape");
}

/**
 * Creates the per-delivery client. @octokit/auth-app authenticates the app
 * endpoints (e.g. GET /app) with the App JWT and everything else with an
 * installation token it issues lazily on first use. A before-request hook
 * pins the REST API version on every request, and the request signal caps the
 * delivery as a whole: octokit keeps it as a client-level default, the only
 * form that reaches all three kinds of dispatch — plain calls, pagination
 * follow-up pages (which carry no per-call request options), and the auth
 * strategy's internal token request, which is issued through this same client.
 * One signal for all of them caps their sum; it aborts as TimeoutError, which
 * maps to status 0 (SPEC.md §4, §9, §11). The delivery budget starts here, so
 * the client is created once per delivery — with the one exception that
 * @octokit/auth-app dedupes in-flight token issuance process-wide by
 * installation id, so overlapping deliveries can share the first one's token
 * request and therefore its deadline (accepted, SPEC.md §9).
 */
export function createGithubClient(
	credentials: AppCredentials,
	installationId: number,
): GithubClient {
	const client = new GithubOctokit({
		auth: {
			appId: credentials.appId,
			installationId,
			privateKey: credentials.privateKeyPem,
		},
		authStrategy: createAppAuth,
		request: { signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) },
		userAgent: USER_AGENT,
	});
	client.hook.before("request", (options) => {
		options.headers["x-github-api-version"] = API_VERSION;
	});
	return client;
}

/** The auth strategy's internal request, issued lazily inside whichever call runs first. */
const TOKEN_ENDPOINT = "POST /app/installations/{installation_id}/access_tokens";
/**
 * TOKEN_ENDPOINT's path, matched whole. A substring test would also match a
 * repository, org, or user named after the marker — a repo named
 * `access_tokens` would make every call to it look like the token request.
 */
const TOKEN_PATH_PATTERN = /^\/app\/installations\/\d+\/access_tokens$/u;

interface HttpFailure {
	/**
	 * Whether the auth strategy's internal token request is the one that failed,
	 * rather than the call the caller asked for. The strategy issues it lazily
	 * inside whichever call runs first, so its failure surfaces as that call's
	 * exception; those two are the only requests a single call dispatches.
	 */
	readonly fromTokenRequest: boolean;
	readonly hasResponse: boolean;
	readonly status: number;
}

/** Whether the failed request is the auth strategy's token request, matched on its path alone; a URL that will not parse is not it. */
function isTokenRequest(url: string): boolean {
	try {
		return TOKEN_PATH_PATTERN.test(new URL(url).pathname);
	} catch {
		return false;
	}
}

/**
 * Narrows a thrown octokit failure: an aborted fetch (the delivery deadline
 * firing), which @octokit/request rethrows as it is rather than wrapping, so it
 * is matched first and by name; or a RequestError, which carries a response for
 * an HTTP failure and none for a transport failure, and whose status, request,
 * and response the package types for us — which is what earns it a line of its
 * own in the §11 table. The request URL is resolved to fromTokenRequest here
 * rather than carried, so both consumers below read the one answer instead of
 * re-parsing the URL for it.
 */
function toHttpFailure(error: unknown): HttpFailure | null {
	if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
		return { fromTokenRequest: false, hasResponse: false, status: NETWORK_FAILURE_STATUS };
	}
	if (!(error instanceof RequestError)) {
		return null;
	}
	return {
		fromTokenRequest: isTokenRequest(error.request.url),
		hasResponse: error.response !== undefined,
		status: error.status,
	};
}

/*
 * True only when the guarded endpoint itself failed with the given status —
 * without excluding the token request, a token-issuance 404 would pass the
 * membership guard and read as a normal "not a member" skip instead of the loud
 * configuration failure §9 requires.
 */
export function isHttpStatusOn(error: unknown, status: number): boolean {
	const failure = toHttpFailure(error);
	if (failure === null) {
		return false;
	}
	return failure.hasResponse && failure.status === status && !failure.fromTokenRequest;
}

/** HTTP failures keep their status, attributed to the auth strategy's token endpoint when its internal request is the one that failed. */
function httpFailureError(endpoint: string, failure: HttpFailure): GithubApiError {
	if (!failure.hasResponse) {
		return new GithubApiError(endpoint, NETWORK_FAILURE_STATUS, "network failure or timeout");
	}
	if (failure.fromTokenRequest) {
		return new GithubApiError(TOKEN_ENDPOINT, failure.status, "unexpected response status");
	}
	return new GithubApiError(endpoint, failure.status, "unexpected response status");
}

/**
 * Maps a thrown octokit failure onto the frozen GithubApiError contract:
 * transport failures and timeouts become status 0, HTTP failures keep their
 * status via httpFailureError above, and anything unrecognized (e.g. an auth
 * configuration failure) is passed through for the handler's internal-error
 * path (SPEC.md §9).
 */
export function toApiError(endpoint: string, error: unknown): Error {
	if (error instanceof GithubApiError) {
		return error;
	}
	const failure = toHttpFailure(error);
	if (failure === null) {
		if (error instanceof Error) {
			return error;
		}
		return new GithubApiError(endpoint, NETWORK_FAILURE_STATUS, "network failure or timeout");
	}
	return httpFailureError(endpoint, failure);
}
