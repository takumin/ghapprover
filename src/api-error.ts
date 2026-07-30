/**
 * The error contract every GitHub call maps onto (SPEC.md §11), and the SPEC.md §8 diagnostics it
 * carries: what a thrown octokit failure becomes, which endpoint that failure is attributed to, and
 * what a caller may ask about it afterwards. Split from the client module (src/client.ts) because
 * the two answer different questions — that one builds the client and owns the delivery budget,
 * this one interprets what comes back out of it — and because the failure mapping is read by
 * src/github.ts and src/pipeline.ts without either of them constructing a client.
 */

import { RequestError } from "@octokit/request-error";

/** GithubApiError status representing network-level failures and timeouts. */
const NETWORK_FAILURE_STATUS = 0;

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
 * firing, src/client.ts), which @octokit/request rethrows as it is rather than
 * wrapping, so it is matched first and by name; or a RequestError, which carries
 * a response for an HTTP failure and none for a transport failure, and whose
 * status, request, and response the package types for us — which is what earns it
 * a line of its own in the §11 table. The request URL is resolved to
 * fromTokenRequest here rather than carried, so both consumers below read the one
 * answer instead of re-parsing the URL for it.
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
	const failed = { diagnostics, endpoint, reason: "unexpected response status", status };
	if (fromTokenRequest) {
		failed.endpoint = TOKEN_ENDPOINT;
	}
	return new GithubApiError(failed);
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
