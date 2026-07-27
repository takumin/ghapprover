/**
 * Minimal fetch-based GitHub REST client (SPEC.md §11, zero dependencies).
 * Responses are parsed as unknown and mapped into the frozen contract types by
 * constructing new objects field-by-field; a response lacking a required field
 * is a broken API contract and throws (fail closed, SPEC.md §9).
 */

/* oxlint-disable max-lines -- the eight-endpoint frozen API lives in one module by design */

import type {
	GithubAccount,
	LivePullRequest,
	OrgMembership,
	PullRequestCommit,
	PullRequestReview,
} from "./types";

const API_BASE_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "ghapprover";
/** SPEC.md §9: no retries inside the Worker, but a timeout on every call. */
const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
/** SPEC.md §3.2: the commits API caps at 250 items, so 3 pages always suffice. */
const MAX_COMMIT_PAGES = 3;
/** GithubApiError status representing network-level failures and timeouts. */
const NETWORK_FAILURE_STATUS = 0;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE_ENTITY = 422;

/** The frozen contract (src/types.ts) models absent data as null, like the API. */
// oxlint-disable-next-line unicorn/no-null -- single sanctioned null literal for the contract above
const NULL_RESULT = null;

export interface RepoRef {
	readonly owner: string;
	readonly repo: string;
}

/**
 * Error for failed GitHub API calls. The endpoint is "METHOD /path" only; the
 * message is built solely from that and a fixed reason — never a token, a
 * query string, or a response body excerpt (SPEC.md §8 warning).
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

function unexpectedStatusError(endpoint: string, status: number): GithubApiError {
	return new GithubApiError(endpoint, status, "unexpected response status");
}
function shapeError(endpoint: string, status: number): GithubApiError {
	return new GithubApiError(endpoint, status, "unexpected response shape");
}

interface GithubRequest {
	readonly body?: string;
	/** The label "METHOD /path" without any query string, safe for error messages. */
	readonly endpoint: string;
	readonly method: string;
	/** Path plus query string, appended to API_BASE_URL. */
	readonly path: string;
	readonly token: string;
}

async function githubFetch(request: GithubRequest): Promise<Response> {
	const headers: Record<string, string> = {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${request.token}`,
		"user-agent": USER_AGENT,
		"x-github-api-version": API_VERSION,
	};
	const init: RequestInit = {
		headers,
		method: request.method,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	};
	if (request.body !== undefined) {
		headers["content-type"] = "application/json";
		init.body = request.body;
	}
	try {
		return await fetch(`${API_BASE_URL}${request.path}`, init);
	} catch {
		throw new GithubApiError(
			request.endpoint,
			NETWORK_FAILURE_STATUS,
			"network failure or timeout",
		);
	}
}

/** Requires a 2xx status, then parses the body as JSON into unknown. */
async function parseOkJson(response: Response, endpoint: string): Promise<unknown> {
	if (!response.ok) {
		throw unexpectedStatusError(endpoint, response.status);
	}
	try {
		return await response.json();
	} catch {
		throw new GithubApiError(endpoint, response.status, "response body is not valid JSON");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
function isUnknownArray(value: unknown): value is readonly unknown[] {
	return Array.isArray(value);
}
/** Key-variable accessor so no index-signature property is accessed by name. */
function field(value: unknown, key: string): unknown {
	if (isRecord(value)) {
		return value[key];
	}
	return undefined;
}
function stringField(value: unknown, key: string): string | undefined {
	const fieldValue = field(value, key);
	if (typeof fieldValue === "string") {
		return fieldValue;
	}
	return undefined;
}
/** Rejects the mapped-but-undefined sentinel: a missing field breaks the contract. */
function required<Value>(value: Value | undefined, endpoint: string, status: number): Value {
	if (value === undefined) {
		throw shapeError(endpoint, status);
	}
	return value;
}

/*
 * Mappers build fresh contract objects from unknown JSON; undefined signals a
 * malformed item and is converted into a GithubApiError by required() above.
 */
function toAccount(value: unknown): GithubAccount | undefined {
	const id = field(value, "id");
	const login = stringField(value, "login");
	const type = stringField(value, "type");
	if (typeof id !== "number" || login === undefined || type === undefined) {
		return undefined;
	}
	return { id, login, type };
}
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

function repoPath(repo: RepoRef): string {
	return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

interface PageQuery {
	readonly endpoint: string;
	readonly path: string;
	readonly token: string;
}
interface Page {
	readonly items: readonly unknown[];
	readonly status: number;
}

/** Deterministic pagination query string: ?per_page=100&page=N. */
async function fetchArrayPage(query: PageQuery, page: number): Promise<Page> {
	const { endpoint, path, token } = query;
	const search = `${path}?per_page=${PAGE_SIZE}&page=${page}`;
	const response = await githubFetch({ endpoint, method: "GET", path: search, token });
	const payload = await parseOkJson(response, endpoint);
	if (!isUnknownArray(payload)) {
		throw shapeError(endpoint, response.status);
	}
	return { items: payload, status: response.status };
}

/** Pages are fetched sequentially (recursion) to stop at the first short page. */
async function fetchCommitPages(query: PageQuery, page: number): Promise<PullRequestCommit[]> {
	const { items, status } = await fetchArrayPage(query, page);
	const commits = items.map((item) => required(toCommitItem(item), query.endpoint, status));
	if (items.length < PAGE_SIZE || page >= MAX_COMMIT_PAGES) {
		return commits;
	}
	return [...commits, ...(await fetchCommitPages(query, page + 1))];
}
async function fetchReviewPages(query: PageQuery, page: number): Promise<PullRequestReview[]> {
	const { items, status } = await fetchArrayPage(query, page);
	const reviews = items.map((item) => required(toReviewItem(item), query.endpoint, status));
	if (items.length < PAGE_SIZE) {
		return reviews;
	}
	return [...reviews, ...(await fetchReviewPages(query, page + 1))];
}

/** GET /app — resolves the App's own non-empty slug (SPEC.md §3 cond. 5). */
export async function fetchAppSlug(appJwt: string): Promise<string> {
	const endpoint = "GET /app";
	const response = await githubFetch({ endpoint, method: "GET", path: "/app", token: appJwt });
	const slug = stringField(await parseOkJson(response, endpoint), "slug");
	if (slug === undefined || slug === "") {
		throw shapeError(endpoint, response.status);
	}
	return slug;
}

/** POST /app/installations/{id}/access_tokens (SPEC.md §7). */
export async function createInstallationToken(
	appJwt: string,
	installationId: number,
): Promise<string> {
	const path = `/app/installations/${installationId}/access_tokens`;
	const endpoint = `POST ${path}`;
	const response = await githubFetch({ endpoint, method: "POST", path, token: appJwt });
	const token = stringField(await parseOkJson(response, endpoint), "token");
	if (token === undefined || token === "") {
		throw shapeError(endpoint, response.status);
	}
	return token;
}

/** All PR commits: per_page=100, pages 1..3 max, early stop on a short page (SPEC.md §3.2). */
export async function listPullRequestCommits(
	token: string,
	repo: RepoRef,
	pullNumber: number,
): Promise<readonly PullRequestCommit[]> {
	const path = `${repoPath(repo)}/pulls/${pullNumber}/commits`;
	return fetchCommitPages({ endpoint: `GET ${path}`, path, token }, 1);
}

/** GET /orgs/{org}/memberships/{username}; a 404 means "not a member" → null (SPEC.md §9). */
export async function fetchOrgMembership(
	token: string,
	org: string,
	username: string,
): Promise<OrgMembership | null> {
	const path = `/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(username)}`;
	const endpoint = `GET ${path}`;
	const response = await githubFetch({ endpoint, method: "GET", path, token });
	if (response.status === HTTP_NOT_FOUND) {
		return NULL_RESULT;
	}
	const payload = await parseOkJson(response, endpoint);
	return required(toMembership(payload), endpoint, response.status);
}

/** All PR reviews, per_page=100 until a short page (SPEC.md §3 cond. 5). */
export async function listPullRequestReviews(
	token: string,
	repo: RepoRef,
	pullNumber: number,
): Promise<readonly PullRequestReview[]> {
	const path = `${repoPath(repo)}/pulls/${pullNumber}/reviews`;
	return fetchReviewPages({ endpoint: `GET ${path}`, path, token }, 1);
}

/** GET /repos/{owner}/{repo}/pulls/{n} for the live TOCTOU check (SPEC.md §3.3). */
export async function fetchPullRequest(
	token: string,
	repo: RepoRef,
	pullNumber: number,
): Promise<LivePullRequest> {
	const path = `${repoPath(repo)}/pulls/${pullNumber}`;
	const endpoint = `GET ${path}`;
	const response = await githubFetch({ endpoint, method: "GET", path, token });
	const payload = await parseOkJson(response, endpoint);
	return required(toLivePullRequest(payload), endpoint, response.status);
}

/**
 * POST an APPROVE review anchored to commitId; a 422 means the PR was closed
 * or merged in the meantime and is treated as a skip (SPEC.md §9).
 */
// oxlint-disable-next-line max-params -- frozen public API signature
export async function createApprovalReview(
	token: string,
	repo: RepoRef,
	pullNumber: number,
	commitId: string,
): Promise<"created" | "rejected"> {
	const path = `${repoPath(repo)}/pulls/${pullNumber}/reviews`;
	const endpoint = `POST ${path}`;
	const body = JSON.stringify({ commit_id: commitId, event: "APPROVE" });
	const response = await githubFetch({ body, endpoint, method: "POST", path, token });
	if (response.ok) {
		return "created";
	}
	if (response.status === HTTP_UNPROCESSABLE_ENTITY) {
		return "rejected";
	}
	throw unexpectedStatusError(endpoint, response.status);
}
