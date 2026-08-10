# ghapprover Specification

A Cloudflare Workers application that automatically approves GitHub pull requests.

**What it does:**

- Acts as a GitHub App and automatically approves PRs created by the organization /
  repository owner themselves or by allowed bots (Renovate / Dependabot / autofix.ci)
- This satisfies the required-review rules of branch protection / rulesets

**Intended use case:** solo development or small teams that want to keep a
"1 required review" branch protection rule without blocking merges of their own PRs
and dependency-update PRs.

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [GitHub App Configuration](#2-github-app-configuration)
   - [2.1 Permissions (least privilege)](#21-permissions-least-privilege)
   - [2.2 Webhook](#22-webhook)
   - [2.3 Installation](#23-installation)
3. [Approval Conditions](#3-approval-conditions)
   - [3.1 Trusted Principals](#31-trusted-principals)
   - [3.2 Commit Verification](#32-commit-verification)
   - [3.3 Race Condition Mitigation (TOCTOU)](#33-race-condition-mitigation-toctou)
   - [3.4 Prerequisite Branch Protection / Ruleset Configuration](#34-prerequisite-branch-protection--ruleset-configuration-users-responsibility)
4. [Processing Flow](#4-processing-flow)
5. [Configuration](#5-configuration)
6. [Idempotency and Duplicate Deliveries](#6-idempotency-and-duplicate-deliveries)
7. [Authentication and Secret Management](#7-authentication-and-secret-management)
8. [Observability](#8-observability)
9. [Error Handling](#9-error-handling)
10. [Out of Scope](#10-out-of-scope)
11. [Dependency Policy](#11-dependency-policy)
12. [Implementation Notes (Informative)](#12-implementation-notes-informative)

## 1. Architecture Overview

```mermaid
flowchart TD
    GH["GitHub (pull_request webhook)"]
    API["GitHub REST API"]

    subgraph W["Cloudflare Workers (ghapprover)"]
        V["Verify webhook signature"]
        E["Evaluate approval conditions<br>(in-code constants + GitHub API)"]
        P["Post an APPROVE review to the PR"]
        V --> E --> P
    end

    GH -->|"POST (signed with X-Hub-Signature-256)"| V
    P -->|"authenticated with an installation token"| API
```

Components:

| Component          | Role                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| GitHub App         | Source of webhook deliveries and principal for API authentication. Approval reviews are posted under the App's bot user |
| Cloudflare Workers | Webhook receiving endpoint. Performs evaluation and approval                                                            |
| Workers Secrets    | Storage for the App ID, private key, and webhook secret                                                                 |

> [!NOTE]
> There is no dynamic configuration. Neither KV nor environment variables (vars) are
> used; the allowed bot list is an in-code constant, and target repositories are
> controlled via the App's installation scope and rulesets (§2, §3.4, §5).

## 2. GitHub App Configuration

### 2.1 Permissions (least privilege)

| Permission           | Access       | Purpose                                                                   |
| -------------------- | ------------ | ------------------------------------------------------------------------- |
| Pull requests        | Read & write | Fetch PR information and the PR's commit list, and post reviews (APPROVE) |
| Contents             | Read & write | Never called; what makes the approval count as a required review (below)  |
| Organization members | Read         | Determine org owners (role=admin)                                         |
| Metadata             | Read         | (Mandatory default permission)                                            |

Contents is the one permission no code path here reaches for, and it is granted for
what it signifies rather than for what it does. GitHub counts a review toward a required
approval only when its author has write access to the repository, and for an App that
means push access — which is this permission and no other. Without it the review is still
posted and still shown on the pull request, but it satisfies nothing: `reviewDecision`
stays `REVIEW_REQUIRED` and the merge box reads "At least 1 approving review is required
by reviewers with write access". The approval is then a signal an operator reads, not a
requirement it meets, and no §3.4 configuration changes that — the rule being asked about
is the count, and the approval never enters it.

Granting it is a real widening and is stated as one: an installation token that could
only comment and approve can now push to every repository in the installation scope, so a
leaked private key (§7) costs code rather than an unwanted approval. The trade is what
buys the App its purpose — an approval that satisfies nothing automates nothing — and it
is bounded by that scope (§2.3) rather than by anything the Worker does. What the Worker
does is not use it: no request signs a commit or writes a ref, and the permission rides on
each per-delivery token unused.

> [!NOTE]
> Whether an approval posted before the permission was granted starts counting once the
> installation accepts it is not established here. Where a pull request stays blocked
> after the grant, redeliver from Recent Deliveries or push again — §6 makes the
> re-evaluation idempotent, so the worst case is an approval that is already there.

### 2.2 Webhook

- Subscribe events: `pull_request` only
- Webhook URL: the Workers endpoint (e.g. `https://ghapprover.<subdomain>.workers.dev/webhook`)
- Webhook secret: required. Stored as a Workers Secret; every request is verified with HMAC-SHA256

### 2.3 Installation

Install on the target organization / personal account. Choose one of the following
installation scopes:

- **Only select repositories** — the installation scope itself controls which
  repositories are targeted. Repositories outside the scope receive no webhook
  deliveries and are never approved
- **All repositories** — targets all repositories (including ones created in the
  future), with effective per-repository control handled on the ruleset side (§3.4)

> [!IMPORTANT]
> The installation scope is the only repository filter that exists: there is no
> repository allowlist in the Worker, and the §3 conditions ask about a PR rather
> than about which repository it arrived from. Failing closed therefore constrains
> which PRs are approved, not which repositories are in play — widening the scope
> is what puts each newly included repository behind those conditions, so every
> qualifying owner or bot PR there will be approved. Treat widening as granting an
> approval path per repository, and pair "All repositories" with the ruleset
> configuration in §3.4.

## 3. Approval Conditions

Approve only when **all** of the following are satisfied. If any condition is not met
or cannot be determined, do not approve (fail closed).

1. **Event condition**: a `pull_request` event whose action is one of `opened` /
   `reopened` / `synchronize` / `ready_for_review`
2. **PR condition**: the PR is open, is not a draft, and its head repository is the
   repository the event came from — `pull_request.head.repo` is neither `null` (the head
   repository was deleted) nor a different repository (a fork). See the second note below
3. **Author condition**: the PR author (`pull_request.user`) is a "trusted principal" (§3.1)
4. **Commit condition**: every commit in the PR passes verification (§3.2)
5. **Duplication condition**: no review whose `user` is the App's own bot user
   (`<app-slug>[bot]`, matched on the login alone — see the third note below), whose
   `state` is `APPROVED`, and whose `commit_id` equals the payload's `head.sha` exists yet
   (if one exists, do nothing and finish successfully).
   Reviews in the `DISMISSED` state do not suppress re-approval: after a manual
   dismissal, the PR can be approved again on the next in-scope event. The reviews
   list API is paginated; fetch all pages
6. **Live-state condition**: immediately before posting the review, the live PR still
   matches the payload (§3.3)

> [!NOTE]
> No target-repository filtering is performed at runtime. GitHub does not deliver
> webhooks for repositories outside the installation scope, so the only repository
> control on the Worker side is the App's installation scope (§2). When installed with
> "All repositories", per-repository control is handled on the ruleset side (§3.4).

> [!NOTE]
> Condition 2's head-repository half: PRs whose head repository is not the one the event
> came from (fork PRs) are not approved (`head-repo-forked`), and neither are PRs whose
> `pull_request.head.repo` is `null` because the head repository was deleted
> (`head-repo-missing`). The comparison is `pull_request.head.repo.id` against
> `repository.id` — the payload's own repository, so no part of `pull_request.base` is
> read (§5). §3.2's guarantee — that third-party commits pushed into a trusted principal's
> PR block approval — rests on `verification.verified` proving who committed them, which
> holds only where write access to the repository is itself the trust boundary. On a fork
> it is not: the base repository's owner cannot see who is able to push to the head
> branch, so a `synchronize` event can carry commits from someone else while the PR author
> stays trusted. The intended use case (§1) pushes branches to the repository itself, so
> the check costs nothing it needs, and it runs before any API call.

> [!NOTE]
> Condition 5 matches the App's own bot user on its login alone — the one identity check
> here that does not also pin a numeric id (§3.1, §3.2). `GET /app` returns the App's id,
> not its bot user's, so there is no id to pin without a further lookup, and the match is
> safe without one: a registrable GitHub username is alphanumeric with single hyphens, so
> no account a person can create carries a `[`, and the `<slug>[bot]` logins that do are
> minted by GitHub from App slugs that are themselves unique. A false match could in any
> case only suppress an approval, never grant one — which is the asymmetry that makes an
> id superfluous here and mandatory in the §3.1 and §3.2 exemptions, which do grant.

### 3.1 Trusted Principals

An account that, in the context of the PR, falls under any of the following:

- **The repository owner themselves**: on a personal repository —
  `repository.owner.type` is anything but `"Organization"` — a user whose `login` and
  numeric `id` both match `repository.owner` (the same id pinning as the bot allowlist
  below; the owner's id is in the webhook payload already)
- **An organization owner**: on an org repository
  (`repository.owner.type == "Organization"`), a user for whom
  `GET /orgs/{org}/memberships/{username}` returns `state=active` and `role=admin`.
  The `author_association` field of the webhook payload is not used for org-owner
  determination (it only reveals MEMBER)
- **An allowed bot**: a bot account whose login is included in the in-code allowlist
  constant (§5) (`renovate[bot]`, `dependabot[bot]`, `autofix-ci[bot]`). Also verify that
  `user.type == "Bot"` and that the numeric user `id` matches the allowlisted one
  (defense in depth against lookalike logins)

Notes:

- The three are branches, not a fallback chain. `repository.owner.type` selects between
  the first two, so an org owner is always resolved through the membership API — the
  owner-match never applies on an org repository, where `repository.owner` is the org
  itself. A `Bot` account is settled by the allowlist alone and falls through to neither,
  so a lookalike bot is rejected without spending a lookup on it
- The definition is applied both to the PR author (condition 3) and to every commit's
  principal (§3.2) — its committer, or its author where GitHub itself is the committer.
  Memoize membership API results per delivery (in memory) so each distinct user is looked
  up at most once
- Bots outside the allowlist (e.g. `github-actions[bot]`) are never trusted; commits
  created by them intentionally block approval
- `autofix-ci[bot]` is allowlisted because CI autofixers push their fixes as commits
  onto the PR branch: without it, a Renovate PR that trips a formatter receives an
  autofix commit and is then permanently unapprovable (the commit cannot be removed
  without a force-push), which defeats the very PRs this App exists to approve. The
  trade-off is explicit — an app with push access to the branch is inside the trust
  boundary either way, and anything it commits is approved. Repositories that do not
  run autofix.ci can drop the entry (§5)

### 3.2 Commit Verification

On every action (`opened`, `synchronize`, etc.), verify all commits of the PR before
approving (`GET /repos/{owner}/{repo}/pulls/{n}/commits`).

First settle what the declared count alone decides, before the fetch is spent:

- If `pull_request.commits` is 0, do not approve (`no-commits`)
- If `pull_request.commits` exceeds the 250-commit cap below, do not approve
  (`too-many-commits`)

Both outcomes are determined by the payload, so checking them first costs no API call and
cannot change the result — a PR settled here would fail the same check after the fetch.

Otherwise fetch every page of the endpoint (`per_page=100`; at most 3 pages given the
cap). Then:

- If the number of commits fetched differs from `pull_request.commits`, do not approve
  (`commit-count-mismatch`, fail closed)

For each commit:

- `commit.verification.verified` is `true`. The `author` / `committer` user objects
  are derived solely from the commit's email addresses, so anyone with push access can
  impersonate a trusted principal — or the `web-flow` user, via `noreply@github.com` —
  by forging the email. A verified signature is what makes one of those two attributions
  binding, and only one: GitHub checks the signature against the **committer's** email
  address and never the author's (`verification.reason` says so in as many words —
  `no_user`, `unverified_email` and `bad_email` are all about the committer email), so
  what a verified commit establishes is that it was committed by a key registered to the
  committer's account, or by GitHub itself (web UI / API commits)
- The commit's **principal** — the account that signature binds — is not null and is a
  trusted principal (§3.1), decided on the `(id, login)` pair rather than the login alone
  wherever the decision is local; the org-membership branch is the one that resolves a
  bare login, because a login is what the membership API takes. The principal is the
  `committer`, except where the committer is `web-flow` (a commit made via the GitHub web
  UI or API), which stands for no actor: there the principal is the `author`. `web-flow`
  is matched on login **and** numeric user id (`19864447`), for the same reason as the
  §3.1 bot allowlist: an identity exemption that decides approval must not turn on a login
  string alone

`author` is read in that one case and nowhere else: it is not a second trust check, but
the same one asked of the only field that names an actor when the committer does not.

If even one commit fails these checks, do not approve. This ensures that if third-party
commits get pushed into a trusted principal's PR (e.g. someone other than the maintainer
pushes to a bot branch), it is not approved.

> [!IMPORTANT]
> The condition is about custody, not authorship. What it establishes is that a trusted
> principal committed every change onto the branch — not that one wrote them. The two come
> apart whenever `author` and `committer` differ: a patch applied on a contributor's
> behalf, a rebase, a cherry-pick, a commit a tool generated and the maintainer signed.
> Custody is the half a signature can carry, and requiring the author to be trusted as well
> buys nothing that closes the gap. It would not stop an untrusted party from naming a
> trusted principal as author, since no key backs that field; it would not stop a trusted
> committer from committing the same change under any other author; and what it does do is
> refuse a maintainer's own signed commits over a name they typed. A third party is blocked
> by something else entirely — they cannot produce a verified commit committed by someone
> who is not them — and that is the committer check.
>
> This is the boundary "approval is not review" is drawn at: a trusted principal signing a
> commit onto the branch is inside it whatever the commit says about who wrote the change.
> Reviewing what they signed is the part this App does not do (§10).

> [!NOTE]
> The web-flow case is the one where the decision falls to the `author`, which no signature
> binds to a key of its own, so it rests on a further property: GitHub does not sign a
> commit whose author the caller chose. The two are mutually exclusive across the write
> paths — the contents API signs and substitutes `web-flow` as committer only when
> `author` and `committer` are both omitted, `createCommitOnBranch` has no author or
> committer input at all, and the git data API leaves an unsigned commit unsigned. A
> verified `web-flow` commit therefore attributes its author to whoever authenticated, and
> an actor with `contents: write` that is not a trusted principal cannot put a commit
> naming one onto a bot's branch. This is observed behaviour rather
> than a documented guarantee: what GitHub documents is that signing for apps and bots
> requires "no custom author information, custom committer information, and no custom
> signature information". Re-check it before relaxing either commit check.

> [!IMPORTANT]
> The PR commits API returns at most 250 commits, which is where the cap comes from: a PR
> declaring more than that cannot be fully verified, so it fails closed — settled from the
> declared count above, before any page is fetched.

### 3.3 Race Condition Mitigation (TOCTOU)

New commits may be pushed to the PR while evaluation is in progress, and GitHub's
review semantics do not close this window by themselves:

- The `commit_id` field of `POST /repos/{owner}/{repo}/pulls/{n}/reviews` only anchors
  what the review is displayed against (and where inline comments attach). GitHub does
  not document it as scoping whether the approval counts for the PR's current head
- "Dismiss stale pull request approvals" snapshots the diff at the moment a review is
  submitted. An approval submitted after an interleaved push therefore snapshots the
  new diff and is not dismissed by that push

Mitigation:

1. Immediately before posting the review, fetch the live PR
   (`GET /repos/{owner}/{repo}/pulls/{n}`) and confirm that it is still open, not a
   draft, and that its `head.sha` equals the payload's `head.sha`. On any mismatch, do
   not approve (200, reason `head-moved`). This also protects against redelivery of
   outdated payloads and against posting reviews to PRs that were closed or merged in
   the meantime
2. Still pass the payload's `head.sha` as `commit_id` so the review is anchored to the
   verified commit for display and audit purposes
3. The remaining window (between the live check and the POST completing) is accepted as
   residual risk, and what it costs is bounded but real. The approval is submitted after
   an interleaved push, so that push does not dismiss it (second bullet above) and the
   commit it carries ends up covered by an approval that never verified it. The push is
   processed as its own `synchronize` event, which does not approve — but that does not
   retract the approval already posted. An unsigned interleaved commit is still blocked
   from merging by the required "Require signed commits" rule (§3.4); a **signed** commit
   from an untrusted principal — an org member who is not an owner (§3.1) — is not, and
   is the residual risk proper. Narrowing the window further would take review semantics
   GitHub does not offer: `commit_id` does not scope what the approval counts for (first
   bullet above), so there is nothing to pin the approval to the head it verified

### 3.4 Prerequisite Branch Protection / Ruleset Configuration (User's Responsibility)

**Require signed commits:**

- Enable "Require signed commits". §3.2 requires `verification.verified == true` on
  every commit, so the repository owner must sign their own commits (a GPG/SSH key
  registered on GitHub) or commit via the GitHub web UI; otherwise their own PRs are
  never approved. This rule keeps day-to-day operation consistent with that requirement
- The allowed bots satisfy it: Mend-hosted Renovate creates commits via the GitHub API
  (`platformCommit: "auto"` resolves to enabled for GitHub App tokens), so its commits
  are GitHub-signed; Dependabot signs its own commits by default; autofix.ci pushes
  through the GitHub API, so its commits are GitHub-signed too and carry `web-flow` as
  committer, which is the one case §3.2 decides on the author instead. A self-hosted
  Renovate pushing unsigned commits over git is not approved (its login also differs from
  `renovate[bot]`, §5)
- Merge strategy caveat: GitHub does not sign the commits it creates for the rebase
  merge strategy. Use squash or merge-commit merges when this rule is enabled

**Dismiss stale approvals:**

- Enable "Dismiss stale pull request approvals when new commits are pushed"
  (both branch protection and rulesets have an equivalent option)
- ghapprover re-verifies all commits and re-approves on every push, so with this setting
  enabled, a PR stays approved only while all of its commits are trusted — outside the
  §3.3 window, where an approval submitted just after an interleaved push is not
  dismissed by that push

**Keeping human review required under "All repositories":**

When installed with "All repositories", ghapprover posts APPROVE on target PRs in every
repository. Rulesets cannot prevent the approval itself from being posted, so for
repositories where human review must remain required, configure one of the following
rulesets so that ghapprover's approval alone does not satisfy the required-review
requirement:

- Set Required approvals to 2 or more (ghapprover's approval counts as 1, the Contents
  permission in §2.1 being what makes it count at all). This keeps ghapprover's approval
  from sufficing on its own, which is what this section asks for — but it does not by
  itself keep a human in the loop, since any other reviewing App or bot on the repository
  counts toward the number just as well. Prefer the Code Owners rule where the requirement
  is human review rather than a second approval
- Enable Require review from Code Owners (the App's bot cannot be a code owner, so its
  approval does not satisfy this requirement). The rule applies only where a PR touches an
  owned path, so it needs a `CODEOWNERS` file covering the repository — a catch-all `*`
  entry included — or a PR touching only unowned paths falls back to the ordinary count

In that case, do not add the owner or the App to the bypass actors.

> [!NOTE]
> Organization-level rulesets are limited to Enterprise Cloud; repository-level
> rulesets are available from Free for public repositories and from Pro / Team and
> above for private repositories. Repositories without a ruleset fall back to the
> default behavior where "one approval from ghapprover satisfies the required review".
> Branch protection is bounded the same way — public repositories on Free, private ones
> from Pro — so on a Free-plan private repository neither prerequisite in this section
> can be configured at all. The App itself still fails closed there (§3.2 is evaluated
> regardless of what the repository requires); what is missing is the merge-side backstop
> the §3.3 residual-risk argument leans on.

**Operational caveats:**

- "Update branch" creates a GitHub-signed merge commit whose author is the user who
  clicked it and whose committer is `web-flow`, so §3.2 decides it on that author. If
  someone other than a trusted principal clicks it on a bot PR, that commit fails §3.2
  and the PR is no longer re-approved until the branch is rebased
- Retargeting a PR to a different base branch (`pull_request.edited`) changes the
  merge base, which dismisses existing approvals under "Dismiss stale approvals".
  Retargeting emits no `synchronize` event, so re-approval happens on the next push or
  via manual redelivery
- "Require approval of the most recent reviewable push" is evaluated temporally (was
  an approval submitted after the latest push), so it does not mitigate the race in
  §3.3 and is not part of this configuration

**Merging:**

- ghapprover only approves; it does not merge. Enabling auto-merge is left to the
  user's operational practice

## 4. Processing Flow

```mermaid
flowchart TD
    A["Request"] --> Z{"Routed to POST /webhook?"}
    Z -->|no| R404["404 (not-found)"]
    Z -->|yes| S{"Is this Worker's own webhook secret set?<br>(§7, before a byte of the body is read)"}
    S -->|no| R500S["500 (missing-webhook-secret)"]
    S -->|yes| L{"Read the body within the 2 MiB cap<br>(part of step 1: the HMAC covers it)"}
    L -->|over the cap| R413["413 (payload-too-large)"]
    L -->|within the cap| B{"1. Verify X-Hub-Signature-256"}
    B -->|invalid| R401["401"]
    B -->|valid| C{"2. Check the event and action, parse the payload,<br>check the PR condition (§3 cond. 1-2)"}
    C -->|out of scope / unsatisfied| R200A["200 (log the reason)"]
    C -->|unmodeled payload / no installation.id| R500["500 (log the reason)"]
    C -->|in scope| D["3. Obtain an installation token"]
    D --> E{"4. Evaluate the author condition<br>(membership API if needed)"}
    E -->|unsatisfied| R200B["200 (log the reason)"]
    E -->|satisfied| F{"5. Fetch and verify all commits"}
    F -->|unsatisfied| R200C["200 (log the reason)"]
    F -->|verified| G{"6. Check existing reviews<br>(suppress duplicate approvals)"}
    G -->|already approved| R200D["200 (already approved)"]
    G -->|not yet approved| H{"7. Fetch the live PR:<br>open, non-draft, head.sha unchanged?"}
    H -->|mismatch| R200F["200 (head-moved)"]
    H -->|unchanged| I{"8. Post APPROVE with commit_id=head.sha"}
    I -->|422| R200G["200 (review-rejected)"]
    I -->|created| R200E["9. Return 200"]
```

- Processing is **synchronous** (not deferred to `ctx.waitUntil`). GitHub API calls per
  delivery: token issuance, the PR author's membership check (§3 condition 3 — only on an
  org repository with a non-bot author), commit list (up to 3 pages), membership checks
  (one per further distinct non-bot commit principal, memoized within the delivery, §3.1),
  the App slug fetch (`GET /app`, §3 condition 5 — the one call authenticated with the App
  JWT rather than an installation token (§7), the one needing no permission at all, and
  the one made once per isolate rather than once per delivery, below), existing reviews
  (paginated), the live PR fetch, and the review POST — typically under 10 calls for PRs
  authored by the owner or an allowed bot. The calls run in that order, with one exception:
  the App slug fetch and the reviews list are issued concurrently, since neither takes an
  argument the other produces and both feed only the duplication check. Being synchronous
  means the outcome is recorded as-is in GitHub's Recent Deliveries, and failures can be
  safely re-executed via manual redelivery (the approval process is idempotent as
  described in §6).
- **The App slug is fetched once per isolate**, not once per delivery: the slug is fixed
  for the lifetime of a deployment, so what is kept in memory (never persisted, as in §7)
  is the lookup itself rather than only the `<slug>[bot]` login it derives, and every
  later delivery reaching step 6 spends neither one of the 50 subrequests the Free plan
  allows nor one call against the API rate limit on re-reading a constant. Holding the
  lookup rather than its result is what makes the count one per isolate rather than one
  per cold start: deliveries that arrive while the first fetch is still in flight join
  that call instead of each issuing its own, which is the only way two concurrent
  deliveries into a fresh isolate cost one `GET /app`. What a joiner does not inherit is
  the budget the shared call is bounded by: that call carries the abort signal of the
  delivery that originated it (below), so an originator near the end of its own deadline
  can fail a lookup a later delivery is still waiting on. A joiner that sees the shared
  lookup fail therefore drops it and attempts once more on its own client, spending the
  deadline that is actually its own; the originator does not retry, having already spent
  its own on that call, and one retry is the bound — a second failure is the delivery's.
  So the cache still cannot turn a delivery that would have succeeded into one that
  fails: it removes calls, never a delivery's own budget. A rejection is not retained: a
  stored failure would be served to every delivery that isolate goes on to handle,
  turning one refused call into a deployment that approves nothing until the isolate is
  recycled, so a failed lookup is dropped and the next delivery fetches again. A stale entry
  needs the App to be renamed under a live isolate, and what it costs is bounded — the
  duplication check stops matching the App's own reviews, so a duplicate approval is
  posted for the current head, which §6 already states has no safety impact. It cannot
  produce an approval the §3 conditions would refuse, because nothing but that check reads
  the login
- **One deadline bounds the whole delivery**: a single wall-clock budget for the delivery
  as a whole, set below GitHub's 10-second webhook timeout. It is created with the client
  and installed on every dispatch, so everything that client spends time on draws on it —
  the auth library's internal waits (§9) as much as the API calls themselves. What it does
  not do is cut a wait short: the signal aborts dispatches, and those waits are plain
  timers that do not carry it. A wait already running when the budget expires therefore
  runs to its end and the abort lands on the dispatch that follows, so a delivery can
  finish up to the longest single wait (3 s, §9) past its budget. **The budget is set so
  that it plus that overrun still clears the 10-second timeout** — the deadline on its own
  does not bound the delivery, only the deadline together with that headroom does. Without
  it a slow delivery could outlive that timeout and still post its approval — recording a
  failed delivery for a PR that was in fact approved, the opposite of the diagnostic
  property this synchronous design exists for. A per-dispatch budget is deliberately not
  layered on top: it starts at or after the delivery budget, so it could only fire first
  by being shorter than the whole delivery, which is the delivery budget again. Exhausting
  the budget fails the delivery closed (§9)
- **Membership lookups are resolved lazily, one at a time, in commit order** (memoized per
  delivery, §3.1), and the first failing commit stops the loop. This is not only a latency
  choice: Workers allows 50 subrequests per request on the Free plan (10,000 on paid), and
  resolving every principal up front would spend up to two lookups per commit on a delivery
  that one early commit already settles. What laziness bounds is exactly that path — a PR
  whose commits are all trusted looks up every distinct principal either way, and a large
  enough one exhausts the Free-plan allowance and fails the delivery closed (§9). It also
  removes, by resolving one at a time, a race between two concurrent lookups of the same
  login that the memoization cannot bound
- **The body read is bounded at 2 MiB** (§9), which is a cap of this Worker's own rather
  than GitHub's. The HMAC covers the raw body, so step 1 has to buffer it before the
  caller is authenticated at all — which makes the buffer the one thing an unauthenticated
  caller on the public endpoint controls. A declared `Content-Length` above the cap is
  rejected before a byte is read, but it cannot be the bound: it is absent on a chunked
  upload, and the same caller chooses whether to send it. So the read counts bytes as they
  arrive and stops at the cap, cancelling the rest of the stream. GitHub caps a delivery at
  25 MB, but a bound set there would be the largest payload the contract permits rather
  than the largest one this Worker could act on, and it is the second that says what an
  unauthenticated caller may spend. 2 MiB is **headroom over documented limits, not a
  measurement**: a `pull_request` payload runs to tens of kilobytes and its largest single
  field, the PR body, is capped at 65,536 characters, so the cap clears anything that shape
  can produce by better than an order of magnitude. What would replace the argument with a
  number is measuring real deliveries, which has not been done. The trade-off is stated
  rather than hidden: a payload between this cap and GitHub's is valid as far as GitHub is
  concerned and is still answered 413, which Recent Deliveries records as a failed delivery
  and which leaves the PR unapproved until a push or a manual redelivery. §9 accepts that
  failure mode for transient failures, where it is temporary and not of this Worker's
  making; here it is neither, and every redelivery of that payload fails the same way. The
  cap bounds what one request costs and not how many arrive — request volume is not bounded
  here at all.
- **This Worker's own webhook secret is read before the body is.** It comes off the binding
  rather than the request, so a deployment that has none can verify nothing and refuses every
  delivery it receives (§9's `missing-webhook-secret`) without buffering a byte of what an
  unauthenticated caller sent. The order is what makes that "every": read after the cap
  instead, a body over the cap or a stream that fails mid-read would be answered
  `payload-too-large` or `internal-error` and point an operator at the delivery rather than at
  the deployment. It stays behind the route check, so a request that never reached
  `POST /webhook` is still `not-found` (§9)
- "Not approving" is a normal outcome (200), and its reason must always be logged.
  5xx is reserved for cases where the evaluation could not be completed (e.g. transient GitHub
  API failures).

## 5. Configuration

There is no dynamic configuration. Neither KV nor environment variables (vars) are used;
the information needed for evaluation comes from the following.

| Decision               | Source                                                                                                                                                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target repositories    | The GitHub App's installation scope (§2). Webhooks are simply not delivered from outside the scope. With "All repositories", per-repository control is handled via rulesets (§3.4)                                                                                         |
| Target branches        | Not a control axis. `pull_request.base` is not read at all, so a PR into a long-lived release branch is approved on exactly the same terms as one into the default branch. Per-branch differences belong in rulesets (§3.4), which is where branch targeting already lives |
| Repository / org owner | Webhook payload + GitHub API (§3.1)                                                                                                                                                                                                                                        |
| Allowed bots           | In-code constant pairing login and numeric user id (e.g. `ALLOWED_BOTS = [{ login: "renovate[bot]", id: 29139614 }, { login: "dependabot[bot]", id: 49699333 }, { login: "autofix-ci[bot]", id: 114827586 }] as const`)                                                    |
| Web-flow committer     | In-code constant in the same shape (`WEB_FLOW = { login: "web-flow", id: 19864447 }`), used to recognize the committer of a GitHub-signed commit, which §3.2 then decides on its author                                                                                    |

- To change the allowed bots, edit the constant and redeploy. The configuration is
  version-controlled in Git, and no path exists to rewrite the approval conditions at runtime
- What this section rules out is configuration the evaluation reads, not bindings as such. The
  one binding declared besides the secrets of §7 — `CF_VERSION_METADATA`, which Cloudflare
  populates with the deployed version's id, tag, and upload timestamp — is neither: no §3
  decision consults it, and it is fixed for the lifetime of a deployment, so nothing about it
  can vary an approval. It records the identity of the deployment doing the reading, which is
  precisely what putting the approval conditions in code leaves a log entry unable to say (§8)
- The allowlist matches the Mend-hosted Renovate app's bot user. Self-hosted Renovate
  deployments run under a different login (their own app slug, or a PAT user of type
  `User`) and are not matched by design
- No runtime configuration loading, no schema validation of configuration, and no
  "configuration missing" branches are needed. The constants are literals whose shape
  TypeScript checks at build time; whether a given numeric id is the right one is settled by
  review and by the tests, not by the compiler. The validation dependency of §11 covers
  untrusted JSON arriving from GitHub, which is a different contract and a different threat

## 6. Idempotency and Duplicate Deliveries

- Duplicate webhook deliveries and redeliveries are assumed. Before approving, check the App's
  own existing reviews and do nothing if an APPROVE for the current head SHA already exists
- Even if the duplication check is somehow bypassed, re-approving the same `commit_id` merely
  adds an extra review and has no safety impact

## 7. Authentication and Secret Management

| Secret                 | Storage        | Purpose                                                                                                    |
| ---------------------- | -------------- | ---------------------------------------------------------------------------------------------------------- |
| GitHub App ID          | Workers Secret | App JWT `iss` claim (§5 rules out vars)                                                                    |
| GitHub App private key | Workers Secret | Signing the App JWT, which issues installation tokens and authenticates the App endpoints (`GET /app`, §4) |
| Webhook secret         | Workers Secret | Signature verification                                                                                     |

- An installation token is issued per event for the installation identified by the
  payload's `installation.id`, using an App JWT (RS256, valid for at most 10
  minutes). Token caching is not required (if done as an optimization, keep it in memory only
  and never persist it)
- Signature verification uses a timing-safe comparison

> [!IMPORTANT]
> GitHub serves App private keys in PKCS#1 format (`-----BEGIN RSA PRIVATE KEY-----`),
> which the Web Crypto API — and therefore the auth library on Workers (§11) — cannot
> import. Convert the key to PKCS#8 once, before storing it as a Workers Secret:
>
> ```sh
> openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
>   -in private-key.pem -out private-key-pkcs8.key
> ```

## 8. Observability

Emit at least the following to structured logs (Workers Logs):

- `deliveryId` (X-GitHub-Delivery), `versionId` (the deployed Worker version, §5), `repo`,
  `prNumber`, `action`, `headSha`
- `decision` (approved / skipped / error) and `reason`
- `level`, the severity the entry is filed at (table below)
- the diagnostic fields the outcome carries (table below)

Every field is logged as soon as it is known, so an outcome decided early carries only
what had been read by then. `deliveryId` comes from the headers alone, so it survives on
entries rejected before the body is looked at (`payload-too-large`,
`missing-webhook-secret`, `invalid-signature`) — it is the only identifier GitHub's Recent
Deliveries shows for a failed delivery, and therefore the one an operator greps by. It is
omitted rather than defaulted when the header is absent, which is the ordinary case for
`not-found`: a request that never reached
`POST /webhook` is usually not a GitHub delivery at all. Surviving those rejections means
it is read before any of them is decided, which makes it the one §8 field an
unauthenticated caller writes into — so it is **truncated to 64 characters**, the header
itself carrying no bound the Worker can rely on. A delivery id is a 36-character UUID, so
that is headroom over the shape rather than a fit to it: nothing GitHub sends is cut, and
whatever is cut was not a delivery id to begin with. Truncating rather than checking the
value against the UUID form is what keeps the field independent of GitHub's current id
format, where a format change would otherwise make it disappear silently. It bounds the
size of such an entry and not the number of them, which is a rate limit at the edge rather
than anything this Worker decides. `versionId` is the id of the
deployed Worker version, taken from the §5 binding, and answers the one question a changed
outcome raises that no other field can: which build produced the entry. Every approval
condition lives in the code — an `ALLOWED_BOTS` entry, a §3 check, the §4 delivery budget —
so entries from either side of a deploy are otherwise indistinguishable, and the behaviour
change that prompts the reading is exactly what leaves no trace in them. It depends on
nothing the request carries, so unlike `deliveryId` it is unconditional: it is on every
entry, including the ones rejected before the body is read and the ones that name no
delivery at all. The payload fields (`repo`, `prNumber`, `action`, `headSha`) appear only
once the body has been parsed.

`reason` is drawn from a closed vocabulary. This is the list an operator greps, so it is
exhaustive rather than illustrative:

| `decision` | `reason`                 | `level` | Meaning                                                                   |
| ---------- | ------------------------ | ------- | ------------------------------------------------------------------------- |
| approved   | _(none)_                 | info    | The review was posted                                                     |
| skipped    | `event-out-of-scope`     | info    | Not a `pull_request` event, or an action outside §3 cond. 1               |
| skipped    | `pr-not-open`            | info    | §3 condition 2: the PR is closed or merged                                |
| skipped    | `pr-draft`               | info    | §3 condition 2: the PR is a draft                                         |
| skipped    | `head-repo-missing`      | warn    | §3 condition 2: `head.repo` is null (the head repository was deleted)     |
| skipped    | `head-repo-forked`       | info    | §3 condition 2: the head repository is not the repository itself (a fork) |
| skipped    | `author-not-trusted`     | info    | §3 condition 3, including a membership 404                                |
| skipped    | `no-commits`             | warn    | §3.2: `pull_request.commits` is 0                                         |
| skipped    | `too-many-commits`       | warn    | §3.2: more than the 250 the commits API can return                        |
| skipped    | `commit-count-mismatch`  | warn    | §3.2: the fetched list differs from the declared count                    |
| skipped    | `unverified-commit`      | info    | §3.2: a commit is not `verification.verified`                             |
| skipped    | `untrusted-commit`       | info    | §3.2: the principal a commit is decided on is not trusted                 |
| skipped    | `already-approved`       | info    | §3 condition 5 / §6: an own APPROVE for this head exists                  |
| skipped    | `head-moved`             | warn    | §3.3: the live PR was closed, turned draft, or left the payload's head    |
| skipped    | `review-rejected`        | warn    | §9: the review POST returned 422                                          |
| error      | `invalid-signature`      | error   | §4 step 1: signature missing, malformed, or not matching                  |
| error      | `missing-webhook-secret` | error   | §4 step 1: this Worker has no webhook secret to verify against (§7)       |
| error      | `payload-too-large`      | error   | §4 step 1: a body above the 2 MiB cap, this Worker's not GitHub's         |
| error      | `not-found`              | error   | A request outside `POST /webhook`                                         |
| error      | `invalid-payload`        | error   | The body is not JSON, or not the modeled `pull_request` shape             |
| error      | `missing-installation`   | error   | The delivery carries no `installation.id` (§7)                            |
| error      | `github-api-error`       | error   | §9: a GitHub API call failed; the diagnostic fields below accompany it    |
| error      | `internal-error`         | error   | Any other thrown failure; the diagnostic fields below accompany it        |

`level` is the severity each reason is filed at, and is the axis `decision` is not:
`decision` says what the delivery did, `level` whether anyone needs to look. Workers Logs
fills its Level column from the field, so an entry that carries none is filed with no
severity at all — a listing that reads the same whether every delivery was approved or
every one of them failed. The entry is emitted through the console method its severity
names as well (`console.error`, `console.warn`, `console.info`), that being the only
severity a tail has to go by, and the two are set together: a column an operator filters by
that disagrees with the stream is worse than one saying nothing. Every `error` decision is
`error` — §9 answers it non-2xx precisely because the evaluation could not be completed, so
that half needs no judgement of its own. The skips are where the judgement is. `info` is a
condition doing its job on a delivery there was never anything wrong with, which a busy
repository produces all day. `warn` is a skip that is still not a failure but is not
routine either: a commit count the API should not have disagreed with, a head that moved
under the evaluation, a head repository that is gone, a review GitHub refused. Reading the
column is worth doing only if the first kind does not drown the second.

Diagnostic fields accompany the outcome named, and only that one. Unlike `reason`, they
are not a vocabulary an operator greps for — they are what turns a grep hit into a cause.

| Field                 | Accompanies                          | Value                                                                  |
| --------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| `endpoint`            | `github-api-error`                   | Route template ("METHOD /path"), never a resolved URL                  |
| `status`              | `github-api-error`                   | HTTP status; 0 for a transport failure or an exhausted §4 deadline     |
| `requestId`           | `github-api-error`                   | `x-github-request-id`, the identifier GitHub support asks for          |
| `acceptedPermissions` | `github-api-error` (401 / 403)       | `x-accepted-github-permissions`: the permission the call needed        |
| `rateLimitRemaining`  | `github-api-error` (403)             | `x-ratelimit-remaining`; 0 marks a rate limit rather than a permission |
| `rateLimitReset`      | `github-api-error` (403)             | `x-ratelimit-reset`                                                    |
| `errorName`           | `internal-error`                     | The thrown value's class name, never its message                       |
| `errorMessage`        | `github-api-error`, `internal-error` | The originating error's message, truncated to 512 characters           |
| `field`               | `invalid-payload`                    | Dot path of the first field that failed validation, never its value    |

- The three response headers are what make §9's "distinguish a configuration problem in
  logs" actionable: a 403 is a missing permission or a rate limit, and `status` alone does
  not say which. They are read from the failed response, so they are absent when there was
  none (a transport failure or the §4 deadline)
- `errorMessage` is the originating error's, captured before it is mapped: the error this
  Worker raises carries a fixed message of its own, which would log nothing the other
  fields do not already say. It is truncated because it is not bounded at the source —
  `@octokit/request` builds it from the response body, and takes the **whole** body when
  that body is not JSON (an HTML error page from GitHub or an upstream proxy)
- `field` is the path alone. A validation failure also carries the offending value, which
  is payload content and stays out (§11)

> [!WARNING]
> The response body carries `decision` and `reason` and nothing else. GitHub displays it
> in Recent Deliveries, which is outside this account's control, so it stays a closed
> vocabulary rather than a diagnostic channel.

> [!WARNING]
> Structured logs never carry tokens, private keys, or the contents of a webhook payload —
> no field values, no titles, no diffs. The identifying metadata listed above (`repo`,
> `prNumber`, `action`, `headSha`) is logged by design and reaches any destination these
> logs are forwarded to. What
> separates them from the response body above is the audience rather than the sensitivity:
> Workers Logs stay inside the Cloudflare account, and that premise is what makes
> `errorMessage` acceptable there and unacceptable in the response. **Enabling Logpush or
> a Tail Worker forwards these logs to an external destination and voids that premise** —
> treat the destination as part of the trust boundary before enabling either. The bounded
> fields stay bounded either way: `endpoint` is a route template, `errorName` a class
> name, `field` a path, and `deliveryId` and `errorMessage` are truncated.

## 9. Error Handling

| Situation                                                             | Response | Notes                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A request outside `POST /webhook`                                     | 404      | `not-found`. Logged like every other outcome (§8), so a webhook URL pointing at the wrong path is greppable rather than silent                                                                                                          |
| Invalid signature / missing signature header                          | 401      | Do not process the body                                                                                                                                                                                                                 |
| This Worker's own webhook secret is unset (§7)                        | 500      | `missing-webhook-secret`. Verification is impossible rather than failed, so it is kept apart from the 401 above: the two point at different secrets, the App's and this deployment's. Fail closed; redeliverable once the Secret is set |
| Request body above the 2 MiB cap — this Worker's, not GitHub's 25 MB  | 413      | `payload-too-large`. Rejected on the declared `Content-Length` before the body is buffered, and on the byte count while it is (§4)                                                                                                      |
| Out-of-scope event / action                                           | 200      | Log the reason                                                                                                                                                                                                                          |
| Approval conditions unsatisfied                                       | 200      | Normal outcome. Log the reason                                                                                                                                                                                                          |
| Membership API returns 404 (the account is not an org member)         | 200      | Normal outcome, not an error: `author-not-trusted` for the PR author, `untrusted-commit` for a commit principal (§3.2)                                                                                                                  |
| Review POST returns 422 (PR closed / merged in the meantime)          | 200      | Normally prevented by the live PR check (§3.3); treated as a skip                                                                                                                                                                       |
| Body is not the modeled `pull_request` payload                        | 500      | `invalid-payload`. The evaluation could not be completed                                                                                                                                                                                |
| Delivery carries no `installation.id`                                 | 500      | `missing-installation`. An App delivery always carries one, so its absence is a configuration problem, not an unsatisfied condition                                                                                                     |
| Transient GitHub API failure                                          | 500      | Fail closed. Retryable via redelivery                                                                                                                                                                                                   |
| Whole-delivery deadline exhausted (§4)                                | 500      | `github-api-error` with `status: 0`. Fail closed                                                                                                                                                                                        |
| Workers subrequest allowance exhausted (§4)                           | 500      | Fail closed. The reason follows how the runtime surfaces it — `github-api-error` if it reaches the client as a failure                                                                                                                  |
| Other GitHub API 4xx (401/403: insufficient permissions, rate limits) | 500      | Distinguish in logs as a configuration problem: `acceptedPermissions` names what a 403 wanted, `rateLimitRemaining` at 0 marks it a rate limit instead (§8)                                                                             |
| Any other thrown failure                                              | 500      | `internal-error` with `errorName` (§8). Fail closed; the class name keeps a configuration mistake distinguishable from a code bug                                                                                                       |

No automatic retries of transient GitHub API failures (5xx / network errors /
timeouts) inside the Worker. What bounds a call that hangs is the whole-delivery
deadline (§4), the only timeout in play: no per-call timeout is layered on top of
it. Re-execution is consolidated into manual redelivery on the GitHub side.

> [!NOTE]
> The auth library (§11) internally performs two bounded kinds of
> auth-consistency retry, accepted as part of the delegated concern: a request
> that receives a 401 within five seconds of installation-token issuance is
> retried while that window lasts (GitHub's token replication delay), and an App
> JWT rejected for clock skew is re-signed once with the reported time
> difference. Neither retries transient API failures; on exhaustion the delivery
> still fails loud per this table.
>
> The 401 retries wait between attempts (1 s, then 2 s, then 3 s), and those
> waits consume the §4 delivery budget exactly like an API call does — it is one
> wall-clock deadline, so time spent waiting is time spent. What the deadline
> cannot do is cut a wait short: it aborts dispatches, and the waits are plain
> timers. A wait running when the budget expires therefore finishes, and the
> abort lands on the retry that follows, so such a delivery ends up to 3 s past
> its budget and fails as `github-api-error` with `status: 0` like any other
> exhaustion. Keeping it inside GitHub's webhook timeout is the budget's job, not
> the deadline's: the budget is chosen with that 3 s of overrun already
> subtracted (§4). The five-second retry window is anchored to the moment the
> token response arrives, not to the start of the delivery, so a slow token
> request shifts the whole window later — which is why the overrun has to be
> budgeted for rather than argued away.
>
> Losing the remaining retries to the deadline costs nothing: the requests being
> retried are themselves failing, so no review is posted, and the state the
> budget exists to prevent — a delivery recorded as failed for a PR that was in
> fact approved — cannot arise on that path. A retry that _succeeds_ after its
> wait does post a review, which is exactly why the overrun is budgeted for
> rather than left to chance.
>
> The library also dedupes in-flight token issuance process-wide, keyed by the
> installation id. Two deliveries for the same installation that overlap in one
> isolate therefore share the first one's token request — and its deadline — so
> the second can fail with `status: 0` while its own budget is untouched. This
> is accepted rather than worked around: the sharing window is exactly how long
> that one request is in flight, a token request slow or broken enough to matter
> would fail both deliveries anyway, and issuing tokens outside the library would
> also give up the retries above.

> [!NOTE]
> GitHub does not automatically redeliver failed webhook deliveries. A transient
> failure on, say, a bot's `opened` event leaves the PR unapproved until a human
> redelivers it manually or a new push triggers `synchronize`. This is an accepted
> limitation.

## 10. Out of Scope

- Merging PRs or enabling auto-merge
- Checking CI status (required checks are the responsibility of branch protection)
- Decisions based on PR body or diff content
- Interactive operations such as comment commands
- Revoking approvals (dismissing stale reviews is the responsibility of branch protection)

## 11. Dependency Policy

Runtime: Cloudflare Workers (TypeScript). External packages are minimized, and the table
below is the whole list. Most of it is GitHub's official `@octokit/*` packages, on the
argument that hand-rolling the GitHub-facing plumbing is more code to audit than the
packages it replaces; where such a package covers a concern, the implementation must
delegate to it. The one non-Octokit entry is admitted on that same argument rather than
as an exception to it (see the note below the table):

| Concern                              | Package                         | Notes                                                        |
| ------------------------------------ | ------------------------------- | ------------------------------------------------------------ |
| Webhook signature verification (§4)  | `@octokit/webhooks-methods`     | `verify()` is Web Crypto based and timing-safe (§7)          |
| App JWT and installation tokens (§7) | `@octokit/auth-app`             | RS256 JWT, token issuance, in-memory token cache             |
| REST calls (§3, §4)                  | `@octokit/core`                 | a delivery-wide `AbortSignal` bounds every dispatch (§4, §9) |
| Pagination (§3.2, §3 condition 5)    | `@octokit/plugin-paginate-rest` | follows the `Link` header; no manual page loops              |
| Failure narrowing (§8, §9)           | `@octokit/request-error`        | typed `status` and `response.headers` on a failure (§8)      |
| Untrusted JSON validation (§3, §4)   | `valibot`                       | schemas are the single source of the §3 contract types       |
| Webhook payload types                | `@octokit/webhooks-types`       | devDependency; type definitions only, never bundled          |

Rules:

1. Direct runtime dependencies are limited to what the table above requires: the official
   `@octokit/*` packages, and any non-Octokit package the table names explicitly against
   the concern it covers. The transitive dependencies they pull in (e.g.
   `universal-github-app-jwt`, `toad-cache`) are part of the package and equally
   acceptable
2. Do not reimplement what the table delegates: no hand-rolled Web Crypto HMAC or
   RS256/JWT code, no bespoke REST client, no manual `Link`-header pagination, no
   field-by-field narrowing of untrusted JSON outside a schema
3. No other runtime dependencies. The single route, the console JSON logging of §8, and
   the in-code constants of §5 need no package: routing and logging libraries would add
   mechanism the platform primitives already cover
4. This spec does not pin package versions; Renovate keeps them current

> [!NOTE]
> `valibot` is the one non-Octokit runtime dependency. What it replaces is field-by-field
> narrowing of every untrusted value — the webhook body and every REST response alike —
> which was more code than the package and, having no vocabulary for _where_ a body
> diverged, could only report that it did. §8's `field` is what a schema makes possible.
> It has no dependencies of its own, is tree-shakable so only the primitives actually used
> are bundled, and runs on the default Workers runtime like the rest of the table.
> Schemas are the single source of truth for the contract types of §3: those types are
> inferred from the schemas rather than declared alongside them, so a field tightened in
> one cannot leave the other looser. The compile-time projection against
> `@octokit/webhooks-types` is kept and applies to the inferred type, so drift from the
> official payload definition still fails the build.
>
> A schema validates; it does not decide. Everything §3 settles — trust, verification,
> duplication — stays in the pure decision functions of §12, so what the package is
> trusted with is the shape of a value and never whether it may be approved.

> [!NOTE]
> The composite packages are deliberately not used: `@octokit/rest` adds generated
> endpoint methods and request logging this Worker does not need, and `octokit`
> further bundles webhooks, OAuth, and retry / throttling plugins — automatic retries
> of transient failures would even conflict with §9 (the auth library's bounded
> auth-consistency retries are the accepted exception noted there). `@octokit/app` is
> rejected on the same balance: it would collapse client construction into
> `getInstallationOctokit`, but pulls in `@octokit/oauth-app` for an OAuth flow this App
> has none of. `@octokit/webhooks` targets long-running Node servers; its verification
> primitive is published standalone as `@octokit/webhooks-methods`, and its own
> event-handler model (registered callbacks returning nothing) does not fit a delivery
> that must reduce to exactly one outcome, one log entry, and one response (§4, §8).

## 12. Implementation Notes (Informative)

- The selected packages are fetch- and Web Crypto-based and run on the default
  Workers runtime without the `nodejs_compat` compatibility flag
- Testing: extract the decision logic (trusted principals, commit verification) as pure
  functions so it can be unit-tested without mocking the GitHub API
- The §3 contract types are inferred from the validation schemas rather than declared
  beside them (§11), which is what keeps the two from drifting. The projection check
  against `@octokit/webhooks-types` applies to the inferred type
- `deliveryId` and `errorMessage` are truncated where the log entry is built rather than
  where the value is raised or read, so every path onto a field whose source imposes no
  bound of its own is bounded by one rule (§8). The diagnostic headers come off the failed
  response, which is why they are absent whenever there was no response at all
