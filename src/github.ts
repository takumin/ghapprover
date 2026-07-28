/**
 * GitHub REST access built on the official octokit packages (SPEC.md §11):
 * @octokit/core issues the requests, @octokit/plugin-paginate-rest follows
 * the Link header for pagination, and @octokit/auth-app signs the App JWT and
 * issues installation tokens (cached in memory per client, SPEC.md §7).
 * Responses are mapped into the frozen contract types by constructing new
 * objects field-by-field; a response lacking a required field is a broken API
 * contract and throws (fail closed, SPEC.md §9).
 */

/* The frozen contract (src/types.ts) models absent data as null, like the API, so null literals are deliberate here. */
/* oxlint-disable unicorn/no-null */
/* oxlint-disable max-lines -- the client factory, error mapping, and six-endpoint frozen API live in one module by design */

import type {
	GithubAccount,
	LivePullRequest,
	OrgMembership,
	PullRequestCommit,
	PullRequestReview,
} from "./types";
import { field, stringField, toAccount } from "./parse";
import { Octokit } from "@octokit/core";
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
 */
const DELIVERY_TIMEOUT_MS = 8000;
const PAGE_SIZE = 100;
/** GithubApiError status representing network-level failures and timeouts. */
const NETWORK_FAILURE_STATUS = 0;
/** Item shape errors surface after a successful page, so they carry 200. */
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE_ENTITY = 422;

const GithubOctokit = Octokit.plugin(paginateRest);

/** Per-delivery client with App auth and Link-header pagination wired in. */
export type GithubClient = InstanceType<typeof GithubOctokit>;

export interface AppCredentials {
	/** GitHub App ID (or client ID), the `iss` claim of the App JWT. */
	readonly appId: string;
	/** GitHub App private key PEM, converted to PKCS#8 (SPEC.md §7). */
	readonly privateKeyPem: string;
}

export interface RepoRef {
	readonly owner: string;
	readonly repo: string;
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

function shapeError(endpoint: string, status: number): GithubApiError {
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

/** Rejects the mapped-but-undefined sentinel: a missing field breaks the contract. */
function required<Value>(value: Value | undefined, endpoint: string, status: number): Value {
	if (value === undefined) {
		throw shapeError(endpoint, status);
	}
	return value;
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

/** Path of the failed request ("" when the URL is absent or unparseable). */
function pathnameOf(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return "";
	}
}
/** Whether a thrown failure's `request` descriptor is the auth strategy's token request. */
function isTokenRequest(request: unknown): boolean {
	return TOKEN_PATH_PATTERN.test(pathnameOf(stringField(request, "url") ?? ""));
}

/**
 * Narrows a thrown octokit failure: a RequestError (name "HttpError", with a
 * response for HTTP failures and without one for transport failures) or an
 * aborted fetch (the delivery deadline firing). The request URL is resolved to
 * fromTokenRequest here rather than carried, so both consumers below read the
 * one answer instead of re-parsing the URL for it.
 */
function toHttpFailure(error: unknown): HttpFailure | null {
	if (!(error instanceof Error)) {
		return null;
	}
	if (error.name === "AbortError" || error.name === "TimeoutError") {
		return { fromTokenRequest: false, hasResponse: false, status: NETWORK_FAILURE_STATUS };
	}
	if (error.name !== "HttpError") {
		return null;
	}
	const status = field(error, "status");
	if (typeof status !== "number") {
		return null;
	}
	return {
		fromTokenRequest: isTokenRequest(field(error, "request")),
		hasResponse: field(error, "response") !== undefined,
		status,
	};
}

/*
 * True only when the guarded endpoint itself failed with the given status —
 * without excluding the token request, a token-issuance 404 would pass the
 * membership guard and read as a normal "not a member" skip instead of the loud
 * configuration failure §9 requires.
 */
function isHttpStatusOn(error: unknown, status: number): boolean {
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
function toApiError(endpoint: string, error: unknown): Error {
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

/*
 * Mappers build fresh contract objects from unknown JSON; undefined signals a
 * malformed item and is converted into a GithubApiError by required() above.
 * The field accessors and toAccount are shared with the payload parser
 * (src/parse.ts) so both paths narrow the contract by the same rules.
 */
function toNullableAccount(value: unknown): GithubAccount | null | undefined {
	if (value === null) {
		return value;
	}
	return toAccount(value);
}
function toNullableString(value: unknown): string | null | undefined {
	if (value === null || typeof value === "string") {
		return value;
	}
	return undefined;
}
function toVerification(value: unknown): PullRequestCommit["commit"]["verification"] | undefined {
	if (value === null) {
		return value;
	}
	const verified = field(value, "verified");
	if (typeof verified === "boolean") {
		return { verified };
	}
	return undefined;
}
function toCommitItem(value: unknown): PullRequestCommit | undefined {
	const author = toNullableAccount(field(value, "author"));
	const committer = toNullableAccount(field(value, "committer"));
	const sha = stringField(value, "sha");
	const verification = toVerification(field(field(value, "commit"), "verification"));
	if (
		author === undefined ||
		committer === undefined ||
		sha === undefined ||
		verification === undefined
	) {
		return undefined;
	}
	return { author, commit: { verification }, committer, sha };
}
function toReviewItem(value: unknown): PullRequestReview | undefined {
	const commitId = toNullableString(field(value, "commit_id"));
	const state = stringField(value, "state");
	const user = toNullableAccount(field(value, "user"));
	if (commitId === undefined || state === undefined || user === undefined) {
		return undefined;
	}
	return { commit_id: commitId, state, user };
}
function toMembership(value: unknown): OrgMembership | undefined {
	const role = stringField(value, "role");
	const state = stringField(value, "state");
	if (role === undefined || state === undefined) {
		return undefined;
	}
	return { role, state };
}
function toLivePullRequest(value: unknown): LivePullRequest | undefined {
	const draft = field(value, "draft");
	const sha = stringField(field(value, "head"), "sha");
	const state = stringField(value, "state");
	if (typeof draft !== "boolean" || sha === undefined || state === undefined) {
		return undefined;
	}
	return { draft, head: { sha }, state };
}

/**
 * GET /app — the App's own bot-user login, which is "<slug>[bot]" for the
 * non-empty slug the endpoint returns (SPEC.md §3 cond. 5). The suffix is a
 * GitHub naming convention, so deriving the login belongs to this module
 * rather than to the caller that matches reviews against it.
 */
export async function fetchAppBotLogin(client: GithubClient): Promise<string> {
	const endpoint = "GET /app";
	try {
		const response = await client.request(endpoint);
		const slug = stringField(response.data, "slug");
		if (slug === undefined || slug === "") {
			throw shapeError(endpoint, response.status);
		}
		return `${slug}[bot]`;
	} catch (error) {
		throw toApiError(endpoint, error);
	}
}

/** All PR commits via Link-header pagination (SPEC.md §3.2); the 250-commit cap is enforced upstream by precheckCommitCount. */
export async function listPullRequestCommits(
	client: GithubClient,
	repo: RepoRef,
	pullNumber: number,
): Promise<readonly PullRequestCommit[]> {
	const endpoint = "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits";
	try {
		const items = await client.paginate(endpoint, {
			owner: repo.owner,
			per_page: PAGE_SIZE,
			pull_number: pullNumber,
			repo: repo.repo,
		});
		return items.map((item) => required(toCommitItem(item), endpoint, HTTP_OK));
	} catch (error) {
		throw toApiError(endpoint, error);
	}
}

/** GET /orgs/{org}/memberships/{username}; a 404 means "not a member" → null (SPEC.md §9). */
export async function fetchOrgMembership(
	client: GithubClient,
	org: string,
	username: string,
): Promise<OrgMembership | null> {
	const endpoint = "GET /orgs/{org}/memberships/{username}";
	try {
		const response = await client.request(endpoint, { org, username });
		return required(toMembership(response.data), endpoint, response.status);
	} catch (error) {
		if (isHttpStatusOn(error, HTTP_NOT_FOUND)) {
			return null;
		}
		throw toApiError(endpoint, error);
	}
}

/** All PR reviews via Link-header pagination (SPEC.md §3 cond. 5). */
export async function listPullRequestReviews(
	client: GithubClient,
	repo: RepoRef,
	pullNumber: number,
): Promise<readonly PullRequestReview[]> {
	const endpoint = "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
	try {
		const items = await client.paginate(endpoint, {
			owner: repo.owner,
			per_page: PAGE_SIZE,
			pull_number: pullNumber,
			repo: repo.repo,
		});
		return items.map((item) => required(toReviewItem(item), endpoint, HTTP_OK));
	} catch (error) {
		throw toApiError(endpoint, error);
	}
}

/** GET /repos/{owner}/{repo}/pulls/{n} for the live TOCTOU check (SPEC.md §3.3). */
export async function fetchPullRequest(
	client: GithubClient,
	repo: RepoRef,
	pullNumber: number,
): Promise<LivePullRequest> {
	const endpoint = "GET /repos/{owner}/{repo}/pulls/{pull_number}";
	try {
		const response = await client.request(endpoint, {
			owner: repo.owner,
			pull_number: pullNumber,
			repo: repo.repo,
		});
		return required(toLivePullRequest(response.data), endpoint, response.status);
	} catch (error) {
		throw toApiError(endpoint, error);
	}
}

/**
 * POST an APPROVE review anchored to commitId; a 422 means the PR was closed
 * or merged in the meantime and is treated as a skip (SPEC.md §9).
 */
// oxlint-disable-next-line max-params -- frozen public API signature
export async function createApprovalReview(
	client: GithubClient,
	repo: RepoRef,
	pullNumber: number,
	commitId: string,
): Promise<"created" | "rejected"> {
	const endpoint = "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
	try {
		await client.request(endpoint, {
			commit_id: commitId,
			event: "APPROVE",
			owner: repo.owner,
			pull_number: pullNumber,
			repo: repo.repo,
		});
		return "created";
	} catch (error) {
		if (isHttpStatusOn(error, HTTP_UNPROCESSABLE_ENTITY)) {
			return "rejected";
		}
		throw toApiError(endpoint, error);
	}
}
