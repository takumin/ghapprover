/**
 * The GitHub REST calls the pipeline makes (SPEC.md §3, §4) and the validation of
 * their responses against the frozen contract schemas (src/types.ts): every value
 * is rebuilt by the schema that models it, and a response that violates one is a
 * broken API contract and throws (fail closed, SPEC.md §9). The client these calls
 * are issued through and the delivery budget bounding them live in src/client.ts;
 * the mapping of a thrown failure onto GithubApiError lives in src/api-error.ts.
 */

import type { GenericSchema, InferOutput } from "valibot";
import { HTTP_NOT_FOUND, HTTP_OK, HTTP_UNPROCESSABLE_ENTITY } from "./http-status";
import type { LivePullRequest, OrgMembership, PullRequestCommit, PullRequestReview } from "./types";
import {
	appSchema,
	livePullRequestSchema,
	orgMembershipSchema,
	pullRequestCommitSchema,
	pullRequestReviewSchema,
} from "./types";
import { isFailureOn, shapeError, toApiError } from "./api-error";
import type { EndpointStatus } from "./api-error";
import type { GithubClient } from "./client";
import { safeParse } from "valibot";

/* The page size every list call asks for. Exported for the suites, which plan their routes on the
 * query it produces rather than on a page size of their own. */
export const PAGE_SIZE = 100;

export interface RepoRef {
	readonly owner: string;
	readonly repo: string;
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
	origin: EndpointStatus,
): InferOutput<Schema> {
	const result = safeParse(schema, value);
	if (!result.success) {
		throw shapeError(origin);
	}
	return result.output;
}

/**
 * The one frame every call below is dispatched inside: whatever it throws leaves as the frozen
 * GithubApiError contract, named after the endpoint asked for (SPEC.md §9, §11). Owned here rather
 * than restated per endpoint, because a call that skipped the mapping would reach the entry point
 * as an internal-error and drop the §8 diagnostics the failed call carries — which compiles, and
 * still works, so nothing else would say so. The dispatch is passed in rather than the route, so
 * each endpoint keeps octokit's own checking of the parameters that route takes.
 */
async function dispatched<Result>(endpoint: string, call: () => Promise<Result>): Promise<Result> {
	try {
		return await call();
	} catch (error) {
		throw toApiError(endpoint, error);
	}
}
/**
 * A call whose one documented failure is an answer rather than an error (SPEC.md §9): a 404 from
 * the membership lookup means "not a member", a 422 from the review POST means the pull request
 * closed underneath it. Stated once, so the two read alike and neither can drift into swallowing
 * more than the one status it is entitled to. Matched on the endpoint as well as the status
 * (src/api-error.ts): the auth strategy issues its token request from inside these very calls, and
 * absorbing its 404 here would turn a configuration failure into a routine skip.
 */
async function answering<Answer, Result>(
	tolerated: EndpointStatus,
	answer: Answer,
	call: () => Promise<Result>,
): Promise<Answer | Result> {
	try {
		return await call();
	} catch (error) {
		if (isFailureOn(error, tolerated)) {
			return answer;
		}
		throw error;
	}
}
/** A response and the schema that models it, through the frame above: the two halves every non-paginated call is made of. */
async function contractCall<Schema extends GenericSchema>(
	endpoint: string,
	call: () => Promise<{ readonly data: unknown; readonly status: number }>,
	schema: Schema,
): Promise<InferOutput<Schema>> {
	const response = await dispatched(endpoint, call);
	return parseContract(schema, response.data, { endpoint, status: response.status });
}

/**
 * GET /app — the App's own bot-user login, which is "<slug>[bot]" for the
 * non-empty slug the endpoint returns (SPEC.md §3 cond. 5). The suffix is a
 * GitHub naming convention, so deriving the login belongs to this module
 * rather than to the caller that matches reviews against it.
 */
export async function fetchAppBotLogin(client: GithubClient): Promise<string> {
	const endpoint = "GET /app";
	const { slug } = await contractCall(
		endpoint,
		async () => {
			const response = await client.request(endpoint);
			return response;
		},
		appSchema,
	);
	return `${slug}[bot]`;
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
	const items = await dispatched(endpoint, async () => {
		const pages = await client.paginate(endpoint, {
			owner: repo.owner,
			per_page: PAGE_SIZE,
			pull_number: pullNumber,
			repo: repo.repo,
		});
		return pages;
	});
	/* Item shape errors surface after a successful page, so they carry 200. */
	return items.map((item) => parseContract(itemSchema, item, { endpoint, status: HTTP_OK }));
}

/** All PR commits via Link-header pagination (SPEC.md §3.2); the 250-commit cap is enforced upstream by precheckCommitCount. */
export async function listPullRequestCommits(
	client: GithubClient,
	repo: RepoRef,
	pullNumber: number,
): Promise<readonly PullRequestCommit[]> {
	const commits = await listPullRequestItems(
		client,
		{ endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", pullNumber, repo },
		pullRequestCommitSchema,
	);
	return commits;
}

/** GET /orgs/{org}/memberships/{username}; a 404 means "not a member" → null (SPEC.md §9). */
export async function fetchOrgMembership(
	client: GithubClient,
	org: string,
	username: string,
): Promise<OrgMembership | null> {
	const endpoint = "GET /orgs/{org}/memberships/{username}";
	const membership = await answering({ endpoint, status: HTTP_NOT_FOUND }, null, async () => {
		const parsed = await contractCall(
			endpoint,
			async () => {
				const response = await client.request(endpoint, { org, username });
				return response;
			},
			orgMembershipSchema,
		);
		return parsed;
	});
	return membership;
}

/** All PR reviews via Link-header pagination (SPEC.md §3 cond. 5). */
export async function listPullRequestReviews(
	client: GithubClient,
	repo: RepoRef,
	pullNumber: number,
): Promise<readonly PullRequestReview[]> {
	const reviews = await listPullRequestItems(
		client,
		{ endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", pullNumber, repo },
		pullRequestReviewSchema,
	);
	return reviews;
}

/** GET /repos/{owner}/{repo}/pulls/{n} for the live TOCTOU check (SPEC.md §3.3). */
export async function fetchPullRequest(
	client: GithubClient,
	repo: RepoRef,
	pullNumber: number,
): Promise<LivePullRequest> {
	const endpoint = "GET /repos/{owner}/{repo}/pulls/{pull_number}";
	const pullRequest = await contractCall(
		endpoint,
		async () => {
			const response = await client.request(endpoint, {
				owner: repo.owner,
				pull_number: pullNumber,
				repo: repo.repo,
			});
			return response;
		},
		livePullRequestSchema,
	);
	return pullRequest;
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
	const review = await answering(
		{ endpoint, status: HTTP_UNPROCESSABLE_ENTITY },
		"rejected" as const,
		async (): Promise<"created"> => {
			await dispatched(endpoint, async () => {
				const response = await client.request(endpoint, {
					commit_id: commitId,
					event: "APPROVE",
					owner: repo.owner,
					pull_number: pullNumber,
					repo: repo.repo,
				});
				return response;
			});
			return "created";
		},
	);
	return review;
}
