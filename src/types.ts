/**
 * Structural subsets of the GitHub webhook payload and REST API responses.
 *
 * Only the fields this Worker actually reads are modeled, with nullability
 * matching the GitHub documentation, so that absence of data is always an
 * explicit branch rather than a runtime surprise (SPEC.md fails closed on
 * anything that cannot be determined). The webhook subset is pinned to the
 * official @octokit/webhooks-types definitions (SPEC.md §11) by the
 * compile-time projection check at the bottom of this file.
 */

import type { PullRequestEvent } from "@octokit/webhooks-types";

declare global {
	/**
	 * Secrets provisioned with `wrangler secret put` (SPEC.md §7).
	 * `wrangler types` only sees bindings declared in wrangler.jsonc, so the
	 * secret names are merged here into the `Env` emitted by the generated
	 * worker-configuration.d.ts (which must stay untouched: CI regenerates it
	 * and fails on drift).
	 */
	interface Env {
		/** GitHub App ID (or client ID), the `iss` claim of the App JWT. */
		readonly GITHUB_APP_ID: string;
		/** GitHub App private key, PKCS#8 PEM (SPEC.md §7); the PKCS#1 PEM GitHub serves is rejected at runtime. */
		readonly GITHUB_APP_PRIVATE_KEY: string;
		/** Webhook secret used for X-Hub-Signature-256 verification. */
		readonly GITHUB_WEBHOOK_SECRET: string;
	}

	// eslint-disable-next-line typescript/no-namespace -- Cloudflare.Env is a namespace member declared by worker-configuration.d.ts; augmenting it has no module-syntax equivalent.
	namespace Cloudflare {
		/** Mirror of the secrets for `env` importers (`cloudflare:test` / `cloudflare:workers`). */
		interface Env {
			readonly GITHUB_APP_ID: string;
			readonly GITHUB_APP_PRIVATE_KEY: string;
			readonly GITHUB_WEBHOOK_SECRET: string;
		}
	}
}

/** A GitHub account (user, bot, or organization) as embedded in payloads. */
export interface GithubAccount {
	readonly login: string;
	readonly id: number;
	/** "User" | "Bot" | "Organization" — kept open because GitHub may add kinds. */
	readonly type: string;
}

/** The `pull_request` webhook payload subset (SPEC.md §3, §4). */
export interface PullRequestEventPayload {
	readonly action: string;
	readonly pull_request: EventPullRequest;
	readonly repository: EventRepository;
	/** Absent when the delivery does not come from an App installation; parsed to null. */
	readonly installation?: { readonly id: number } | null;
}

export interface EventPullRequest {
	readonly number: number;
	/** "open" | "closed" */
	readonly state: string;
	readonly draft: boolean;
	/** Declared commit count, compared against the fetched list (SPEC.md §3.2). */
	readonly commits: number;
	readonly user: GithubAccount;
	readonly head: PullRequestHead;
}

export interface PullRequestHead {
	readonly sha: string;
	/** Null when the head repository (e.g. a fork) was deleted (SPEC.md §3). */
	readonly repo: { readonly id: number } | null;
}

export interface EventRepository {
	/** Compared against `head.repo.id` to reject fork PRs (SPEC.md §3 note). */
	readonly id: number;
	readonly name: string;
	readonly full_name: string;
	readonly owner: GithubAccount;
}

/** `GET /repos/{owner}/{repo}/pulls/{n}` subset for the live check (SPEC.md §3.3). */
export interface LivePullRequest {
	readonly state: string;
	readonly draft: boolean;
	readonly head: { readonly sha: string };
}

/** `GET /repos/{owner}/{repo}/pulls/{n}/commits` item subset (SPEC.md §3.2). */
export interface PullRequestCommit {
	readonly sha: string;
	readonly commit: {
		readonly verification: { readonly verified: boolean } | null;
	};
	/** Null when the email does not map to a GitHub account. */
	readonly author: GithubAccount | null;
	readonly committer: GithubAccount | null;
}

/** `GET /repos/{owner}/{repo}/pulls/{n}/reviews` item subset (SPEC.md §3 cond. 5). */
export interface PullRequestReview {
	readonly user: GithubAccount | null;
	/** "APPROVED" | "DISMISSED" | "CHANGES_REQUESTED" | "COMMENTED" | ... */
	readonly state: string;
	readonly commit_id: string | null;
}

/** `GET /orgs/{org}/memberships/{username}` subset (SPEC.md §3.1). */
export interface OrgMembership {
	/** "active" | "pending" */
	readonly state: string;
	/** "admin" | "member" | "billing_manager" */
	readonly role: string;
}

/** Resolves only when Payload is assignable to Subset; used as a compile-time assertion. */
type ProjectionOf<Payload extends Subset, Subset> = Payload;

/**
 * Compile-time projection check (SPEC.md §11): every genuine `pull_request`
 * payload, as defined by the official @octokit/webhooks-types package, must
 * satisfy the modeled subset above. If either side drifts, this alias stops
 * compiling. The runtime still validates fail closed (src/decision.ts),
 * because a verified signature proves origin, not shape.
 */
export type PullRequestEventContract = ProjectionOf<PullRequestEvent, PullRequestEventPayload>;
