/**
 * The GitHub REST calls the pipeline makes (SPEC.md §3, §4) and the validation of
 * their responses against the frozen contract schemas (src/types.ts): every value
 * is rebuilt by the schema that models it, and a response that violates one is a
 * broken API contract and throws (fail closed, SPEC.md §9). The client these calls
 * are issued through, the delivery budget bounding them, and the mapping of a
 * thrown failure onto GithubApiError live in src/client.ts.
 */

import type { GenericSchema, InferOutput } from "valibot";
import type { LivePullRequest, OrgMembership, PullRequestCommit, PullRequestReview } from "./types";
import {
	appSchema,
	livePullRequestSchema,
	orgMembershipSchema,
	pullRequestCommitSchema,
	pullRequestReviewSchema,
} from "./types";
import { isHttpStatusOn, shapeError, toApiError } from "./client";
import type { GithubClient } from "./client";
import { safeParse } from "valibot";

const PAGE_SIZE = 100;
/** Item shape errors surface after a successful page, so they carry 200. */
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE_ENTITY = 422;

export interface RepoRef {
	readonly owner: string;
	readonly repo: string;
}

/** What a shape violation is attributed to: the route that answered, and the status it answered with. */
interface ResponseOrigin {
	readonly endpoint: string;
	readonly status: number;
}

/*
 * One response value against the schema that models it. The schema rebuilds the value from the
 * modeled fields alone, so nothing unmodeled travels on from here, and a violation throws as a
 * github-api-error naming the route (SPEC.md §9). The validation issue itself is discarded: §8
 * gives `field` to invalid-payload alone, where the body is the App's own contract with GitHub;
 * a response that breaks its shape is already located by the endpoint the error names.
 */
function parseContract<Schema extends GenericSchema>(
	schema: Schema,
	value: unknown,
	origin: ResponseOrigin,
): InferOutput<Schema> {
	const result = safeParse(schema, value);
	if (!result.success) {
		throw shapeError(origin.endpoint, origin.status);
	}
	return result.output;
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
		const { status } = response;
		const { slug } = parseContract(appSchema, response.data, { endpoint, status });
		return `${slug}[bot]`;
	} catch (error) {
		throw toApiError(endpoint, error);
	}
}

/** The two paginated per-PR list endpoints; both take the same parameters and differ only in the item shape. */
type PullRequestListEndpoint =
	| "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits"
	| "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews";

/** Follows the Link header to the last page and validates every item against the frozen contract. */
async function listPullRequestItems<Schema extends GenericSchema>(
	client: GithubClient,
	list: {
		readonly endpoint: PullRequestListEndpoint;
		readonly pullNumber: number;
		readonly repo: RepoRef;
	},
	itemSchema: Schema,
): Promise<readonly InferOutput<Schema>[]> {
	const { endpoint, pullNumber, repo } = list;
	try {
		const items = await client.paginate(endpoint, {
			owner: repo.owner,
			per_page: PAGE_SIZE,
			pull_number: pullNumber,
			repo: repo.repo,
		});
		return items.map((item) => parseContract(itemSchema, item, { endpoint, status: HTTP_OK }));
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
		pullRequestCommitSchema,
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
		const { status } = response;
		return parseContract(orgMembershipSchema, response.data, { endpoint, status });
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
		pullRequestReviewSchema,
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
		const { status } = response;
		return parseContract(livePullRequestSchema, response.data, { endpoint, status });
	} catch (error) {
		throw toApiError(endpoint, error);
	}
}

/** The pull request and head commit one approval review is anchored to, and the caller's §3.3 live check compares against. */
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
