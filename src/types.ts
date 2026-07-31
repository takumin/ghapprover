/**
 * The contract this Worker holds the GitHub webhook payload and REST API responses to
 * (SPEC.md §11): valibot schemas, and the types inferred from them. The schemas are the
 * single source — every type below is inferred rather than declared beside its schema, so
 * a field tightened in one cannot leave the other looser (SPEC.md §12).
 *
 * Only the fields this Worker actually reads are modeled, with nullability matching the
 * GitHub documentation, so that absence of data is always an explicit branch rather than a
 * runtime surprise (SPEC.md fails closed on anything that cannot be determined). `object`
 * rather than `looseObject` or `strictObject`: it strips unmodeled keys, so a validated
 * value is a freshly rebuilt subset rather than the untrusted JSON itself, while a key
 * GitHub adds later is not a validation failure. Every object is piped through `readonly()`,
 * which keeps the inferred contract as frozen as the hand-written interfaces it replaces.
 * The webhook subset is pinned to the official @octokit/webhooks-types definitions by the
 * compile-time projection check at the bottom of this file.
 */

import {
	boolean,
	fallback,
	nonEmpty,
	nullable,
	nullish,
	number,
	object,
	optional,
	pipe,
	readonly,
	string,
} from "valibot";
import type { InferOutput } from "valibot";
import type { PullRequestEvent } from "@octokit/webhooks-types";

declare global {
	/**
	 * What the Workers runtime hands the entry point. `wrangler types` only sees
	 * bindings declared in wrangler.jsonc, so the secrets of SPEC.md §7 — which
	 * `wrangler secret put` provisions and the config never names — are merged here
	 * into the `Env` emitted by the generated worker-configuration.d.ts (which must
	 * stay untouched: CI regenerates it and fails on drift). The one binding the
	 * config does declare is restated for the different reason given below.
	 */
	interface Env {
		/**
		 * The deployed Worker version (SPEC.md §5), whose id every log entry carries (§8).
		 * Generated already, being declared in wrangler.jsonc; narrowed to readonly here so
		 * that `Env` stays a value a delivery reads and never one it could write into, which
		 * is what the three secrets below get from their own modifiers.
		 */
		readonly CF_VERSION_METADATA: Readonly<WorkerVersionMetadata>;
		/** GitHub App ID (or client ID), the `iss` claim of the App JWT. */
		readonly GITHUB_APP_ID: string;
		/** GitHub App private key, PKCS#8 PEM (SPEC.md §7); the PKCS#1 PEM GitHub serves is rejected at runtime. */
		readonly GITHUB_APP_PRIVATE_KEY: string;
		/** Webhook secret used for X-Hub-Signature-256 verification. */
		readonly GITHUB_WEBHOOK_SECRET: string;
	}

	// eslint-disable-next-line typescript/no-namespace -- Cloudflare.Env is a namespace member declared by worker-configuration.d.ts; augmenting it has no module-syntax equivalent.
	namespace Cloudflare {
		/** Mirror of the above for `env` importers (`cloudflare:test` / `cloudflare:workers`). */
		interface Env {
			readonly CF_VERSION_METADATA: Readonly<WorkerVersionMetadata>;
			readonly GITHUB_APP_ID: string;
			readonly GITHUB_APP_PRIVATE_KEY: string;
			readonly GITHUB_WEBHOOK_SECRET: string;
		}
	}
}

/** A bare `{ id }` reference: the installation (SPEC.md §7) and the head repository (§3 cond. 2). */
const idRefSchema = pipe(object({ id: number() }), readonly());

/**
 * Absence itself, so it can be handed to a schema combinator that takes a value: a bare
 * `undefined` argument is not a spelling the lint gate leaves available
 * (`unicorn/no-useless-undefined`), and `null` is not one this codebase writes
 * (`unicorn/no-null`) — it is what GitHub sends, not how absence is said here.
 */
const ABSENT = undefined;

/** A GitHub account (user, bot, or organization) as embedded in payloads; `type` is
 * "User" | "Bot" | "Organization", kept open because GitHub may add kinds. */
const accountSchema = pipe(object({ id: number(), login: string(), type: string() }), readonly());
type GithubAccount = InferOutput<typeof accountSchema>;
/** Null when the commit email or the review author does not map to a GitHub account. */
const nullableAccountSchema = nullable(accountSchema);

/* A deleted head repository is absent rather than malformed, so the `null` GitHub sends and an
 * absent key alike validate (SPEC.md §3 condition 2), while a value of any other shape fails
 * validation. That is what keeps "the head repository is gone" — a skip — apart from "this body is
 * not a pull_request payload" — a 500. Both spellings of absence are left as they arrived rather
 * than normalized onto one: the reader tests for a repository, not for which of the two it was. */
const headRepoSchema = nullish(idRefSchema);
const headSchema = pipe(object({ repo: headRepoSchema, sha: string() }), readonly());

const pullRequestSchema = pipe(
	object({
		/** Declared commit count, compared against the fetched list (SPEC.md §3.2). */
		commits: number(),
		draft: boolean(),
		head: headSchema,
		number: number(),
		/** "open" | "closed" */
		state: string(),
		user: accountSchema,
	}),
	readonly(),
);
type EventPullRequest = InferOutput<typeof pullRequestSchema>;

const repositorySchema = pipe(
	object({
		full_name: string(),
		/** Compared against `head.repo.id` to reject fork PRs (SPEC.md §3 condition 2). */
		id: number(),
		name: string(),
		owner: accountSchema,
	}),
	readonly(),
);
type EventRepository = InferOutput<typeof repositorySchema>;

/* Absent and malformed alike leave the payload valid with no installation (SPEC.md §9): such a
 * delivery fails as missing-installation, which says the App is misconfigured, rather than as
 * invalid-payload, which would say the body is not a pull_request event at all. `fallback`
 * settles the malformed half, `optional` the absent one — and `optional` without a default,
 * because a default would make the key required in the inferred type and so break the
 * projection check below against a payload definition where it is optional. */
const installationSchema = optional(fallback(nullish(idRefSchema), ABSENT));

/** The `pull_request` webhook payload subset (SPEC.md §3, §4). */
const pullRequestEventSchema = pipe(
	object({
		action: string(),
		installation: installationSchema,
		pull_request: pullRequestSchema,
		repository: repositorySchema,
	}),
	readonly(),
);
type PullRequestEventPayload = InferOutput<typeof pullRequestEventSchema>;

/* GET /app subset (SPEC.md §3 cond. 5): the App's bot login is "<slug>[bot]", so an empty slug
 * would derive the login "[bot]" and match reviews by no one. The non-emptiness is part of the
 * shape rather than a check at the call site, so the one schema states what the response must be. */
const slugSchema = pipe(string(), nonEmpty());
const appSchema = pipe(object({ slug: slugSchema }), readonly());

/** `GET /repos/{owner}/{repo}/pulls/{n}` subset for the live check (SPEC.md §3.3). */
const liveHeadSchema = pipe(object({ sha: string() }), readonly());
const livePullRequestSchema = pipe(
	object({ draft: boolean(), head: liveHeadSchema, state: string() }),
	readonly(),
);
type LivePullRequest = InferOutput<typeof livePullRequestSchema>;

/** `GET /repos/{owner}/{repo}/pulls/{n}/commits` item subset (SPEC.md §3.2). */
const verificationSchema = pipe(object({ verified: boolean() }), readonly());
const commitDetailSchema = pipe(object({ verification: nullable(verificationSchema) }), readonly());
const pullRequestCommitSchema = pipe(
	object({
		author: nullableAccountSchema,
		commit: commitDetailSchema,
		committer: nullableAccountSchema,
		sha: string(),
	}),
	readonly(),
);
type PullRequestCommit = InferOutput<typeof pullRequestCommitSchema>;

/** `GET /repos/{owner}/{repo}/pulls/{n}/reviews` item subset (SPEC.md §3 cond. 5). */
const commitIdSchema = nullable(string());
const pullRequestReviewSchema = pipe(
	object({
		commit_id: commitIdSchema,
		/** "APPROVED" | "DISMISSED" | "CHANGES_REQUESTED" | "COMMENTED" | ... */
		state: string(),
		user: nullableAccountSchema,
	}),
	readonly(),
);
type PullRequestReview = InferOutput<typeof pullRequestReviewSchema>;

/** `GET /orgs/{org}/memberships/{username}` subset (SPEC.md §3.1). */
const orgMembershipSchema = pipe(
	object({
		/** "admin" | "member" | "billing_manager" */
		role: string(),
		/** "active" | "pending" */
		state: string(),
	}),
	readonly(),
);
type OrgMembership = InferOutput<typeof orgMembershipSchema>;

/** Resolves only when Payload is assignable to Subset; used as a compile-time assertion. */
type ProjectionOf<Payload extends Subset, Subset> = Payload;

/**
 * Compile-time projection check (SPEC.md §11): every genuine `pull_request`
 * payload, as defined by the official @octokit/webhooks-types package, must
 * satisfy the modeled subset above — which is the type inferred from the schema,
 * so tightening the schema is what this check is applied to. If either side
 * drifts, this alias stops compiling. The runtime still validates fail closed
 * (src/pipeline.ts), because a verified signature proves origin, not shape.
 */
type PullRequestEventContract = ProjectionOf<PullRequestEvent, PullRequestEventPayload>;

export {
	appSchema,
	livePullRequestSchema,
	orgMembershipSchema,
	pullRequestCommitSchema,
	pullRequestEventSchema,
	pullRequestReviewSchema,
};
export type {
	EventPullRequest,
	EventRepository,
	GithubAccount,
	LivePullRequest,
	OrgMembership,
	PullRequestCommit,
	PullRequestEventContract,
	PullRequestEventPayload,
	PullRequestReview,
};
