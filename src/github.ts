/**
 * The GitHub REST calls the pipeline makes (SPEC.md §3, §4) and the mapping of
 * their responses onto the frozen contract types (src/types.ts): every object is
 * constructed field-by-field from unknown JSON, and a response lacking a required
 * field is a broken API contract and throws (fail closed, SPEC.md §9). The client
 * these calls are issued through, the delivery budget bounding them, and the
 * mapping of a thrown failure onto GithubApiError live in src/client.ts.
 */

import type {
	GithubAccount,
	LivePullRequest,
	OrgMembership,
	PullRequestCommit,
	PullRequestReview,
} from "./types";
import { field, stringField, toAccount } from "./parse";
import { isHttpStatusOn, shapeError, toApiError } from "./client";
import type { GithubClient } from "./client";

const PAGE_SIZE = 100;
/** Item shape errors surface after a successful page, so they carry 200. */
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE_ENTITY = 422;

export interface RepoRef {
	readonly owner: string;
	readonly repo: string;
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

/** The two paginated per-PR list endpoints; both take the same parameters and differ only in the item shape. */
type PullRequestListEndpoint =
	| "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits"
	| "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews";

/** Follows the Link header to the last page and maps every item through the frozen contract. */
async function listPullRequestItems<Item>(
	client: GithubClient,
	list: {
		readonly endpoint: PullRequestListEndpoint;
		readonly pullNumber: number;
		readonly repo: RepoRef;
	},
	toItem: (value: unknown) => Item | undefined,
): Promise<readonly Item[]> {
	const { endpoint, pullNumber, repo } = list;
	try {
		const items = await client.paginate(endpoint, {
			owner: repo.owner,
			per_page: PAGE_SIZE,
			pull_number: pullNumber,
			repo: repo.repo,
		});
		return items.map((item) => required(toItem(item), endpoint, HTTP_OK));
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
	return listPullRequestItems(
		client,
		{ endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", pullNumber, repo },
		toCommitItem,
	);
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
	return listPullRequestItems(
		client,
		{ endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", pullNumber, repo },
		toReviewItem,
	);
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

/** The pull request and head commit one approval review is anchored to. */
export interface ApprovalTarget {
	readonly commitId: string;
	readonly pullNumber: number;
	readonly repo: RepoRef;
}

/**
 * POST an APPROVE review anchored to commitId; a 422 means the PR was closed
 * or merged in the meantime and is treated as a skip (SPEC.md §9).
 */
export async function createApprovalReview(
	client: GithubClient,
	target: ApprovalTarget,
): Promise<"created" | "rejected"> {
	const { commitId, pullNumber, repo } = target;
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
