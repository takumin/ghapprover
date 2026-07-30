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
 * The SPEC.md §8 diagnostics of a failed call, beyond its endpoint and status:
 * the originating error's message, and the three response headers that separate
 * a 403 for a missing permission from a 403 for a rate limit. One group rather
 * than five fields because they are read off one failed request together and
 * absent together when it received no response.
 */
export interface ApiDiagnostics {
	readonly acceptedPermissions: string | undefined;
	readonly errorMessage: string | undefined;
	readonly rateLimitRemaining: string | undefined;
	readonly rateLimitReset: string | undefined;
	readonly requestId: string | undefined;
}
/** What a failure with no response carries: the originating message alone, and not even that when this Worker raised the failure itself. */
function withoutResponse(errorMessage?: string): ApiDiagnostics {
	return {
		acceptedPermissions: undefined,
		errorMessage,
		rateLimitRemaining: undefined,
		rateLimitReset: undefined,
		requestId: undefined,
	};
}
const NO_DIAGNOSTICS: ApiDiagnostics = withoutResponse();

/** What a GithubApiError states: the route it names, the status it keeps, the fixed reason its message gives, and the §8 diagnostics it carries. */
interface ApiFailure {
	readonly diagnostics: ApiDiagnostics;
	readonly endpoint: string;
	readonly reason: string;
	readonly status: number;
}

/**
 * Error for failed GitHub API calls. The endpoint is the "METHOD /path"
 * route template only; the message is built solely from that and a fixed
 * reason — never a token, a query string, or a response body excerpt
 * (SPEC.md §8 warning). The §8 diagnostics ride alongside in a field rather
 * than in that message, errorMessage among them: it is the *originating*
 * error's message, which is the one thing the fixed one cannot restate.
 */
export class GithubApiError extends Error {
	public readonly diagnostics: ApiDiagnostics;
	public readonly endpoint: string;
	public readonly status: number;

	/* One parameter object rather than a positional list: the diagnostics made it a fourth
	 * argument, past what eslint/max-params allows, and `reason` reads as itself only when named. */
	public constructor(failure: ApiFailure) {
		const { diagnostics, endpoint, reason, status } = failure;
		super(`GitHub API call ${endpoint} failed (status ${status}): ${reason}`);
		this.name = "GithubApiError";
		this.diagnostics = diagnostics;
		this.endpoint = endpoint;
		this.status = status;
	}
}

export function shapeError(endpoint: string, status: number): GithubApiError {
	return new GithubApiError({
		diagnostics: NO_DIAGNOSTICS,
		endpoint,
		reason: "unexpected response shape",
		status,
	});
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
	readonly diagnostics: ApiDiagnostics;
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
 * The SPEC.md §8 diagnostics of a thrown RequestError, taken before the mapping
 * below replaces its message with a fixed one: @octokit/request builds that
 * message from the response body, so it is the only field that says why GitHub
 * refused rather than merely that it did (unbounded there, and truncated where
 * the log entry is built, §12). The headers come off the response, so a failure
 * that never received one carries none of them.
 */
function diagnosticsOf(error: RequestError): ApiDiagnostics {
	const { response } = error;
	if (response === undefined) {
		return withoutResponse(error.message);
	}
	const { headers } = response;
	return {
		acceptedPermissions: headers["x-accepted-github-permissions"],
		errorMessage: error.message,
		rateLimitRemaining: headers["x-ratelimit-remaining"],
		rateLimitReset: headers["x-ratelimit-reset"],
		requestId: headers["x-github-request-id"],
	};
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
		return {
			diagnostics: withoutResponse(error.message),
			fromTokenRequest: false,
			hasResponse: false,
			status: NETWORK_FAILURE_STATUS,
		};
	}
	if (!(error instanceof RequestError)) {
		return null;
	}
	return {
		diagnostics: diagnosticsOf(error),
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

/** Status 0: a call that never received a response — a transport failure, or the §4 deadline firing. */
function transportError(endpoint: string, diagnostics: ApiDiagnostics): GithubApiError {
	return new GithubApiError({
		diagnostics,
		endpoint,
		reason: "network failure or timeout",
		status: NETWORK_FAILURE_STATUS,
	});
}
/** HTTP failures keep their status, attributed to the auth strategy's token endpoint when its internal request is the one that failed. */
function httpFailureError(endpoint: string, failure: HttpFailure): GithubApiError {
	const { diagnostics, fromTokenRequest, hasResponse, status } = failure;
	if (!hasResponse) {
		return transportError(endpoint, diagnostics);
	}
	const reason = "unexpected response status";
	if (fromTokenRequest) {
		return new GithubApiError({ diagnostics, endpoint: TOKEN_ENDPOINT, reason, status });
	}
	return new GithubApiError({ diagnostics, endpoint, reason, status });
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
		return transportError(endpoint, NO_DIAGNOSTICS);
	}
	return httpFailureError(endpoint, failure);
}
