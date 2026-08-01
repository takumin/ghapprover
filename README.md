# ghapprover

[![CI](https://github.com/takumin/ghapprover/actions/workflows/ci.yml/badge.svg)](https://github.com/takumin/ghapprover/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

A GitHub App on Cloudflare Workers that automatically approves pull requests opened by
the repository owner themselves or by allowed bots.

This is not a hosted service. There is no shared instance to install: you deploy the
Worker to your own Cloudflare account, register your own GitHub App against it, and
install that App on your own repositories. Everything below assumes that setup.

## Table of Contents

- [Why](#why)
- [What gets approved](#what-gets-approved)
- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
  - [1. Deploy the Worker](#1-deploy-the-worker)
  - [2. Create the GitHub App](#2-create-the-github-app)
  - [3. Convert the private key to PKCS#8](#3-convert-the-private-key-to-pkcs8)
  - [4. Store the secrets](#4-store-the-secrets)
  - [5. Install the App](#5-install-the-app)
  - [6. Configure branch protection or a ruleset](#6-configure-branch-protection-or-a-ruleset)
- [Verifying the setup](#verifying-the-setup)
- [Customization](#customization)
- [Security considerations](#security-considerations)
- [Observability](#observability)
- [Troubleshooting](#troubleshooting)
- [Teardown](#teardown)
- [Development](#development)
- [Contributing](#contributing)
- [Documentation](#documentation)
- [License](#license)

## Why

A "1 required review" branch protection rule is the cheapest way to keep every change
flowing through a pull request. On a solo project or a small team it also blocks the
merges it was never meant to block — your own pull requests, and the dependency-update
pull requests Renovate and Dependabot open all week.

ghapprover satisfies that requirement for exactly those pull requests, and nothing else.
It is not a substitute for review: it approves changes whose authorship is already inside
the repository's trust boundary, so that the rule keeps applying to everything that is
not.

## What gets approved

A pull request is approved only when **all** of the following hold. If any of them is
unmet, or cannot be determined, ghapprover does not approve (fail closed).

1. **Event** — a `pull_request` event whose action is `opened`, `reopened`,
   `synchronize`, or `ready_for_review`.
2. **Pull request state** — open, not a draft, and its head repository is the repository
   the event came from. Fork pull requests are never approved.
3. **Author** — the pull request author is a trusted principal.
4. **Commits** — every commit in the pull request is signature-verified, and its author
   and committer are trusted principals (the committer may also be `web-flow`, i.e. a
   commit made through the GitHub web UI or API). A pull request whose commits cannot all
   be accounted for is refused instead of verified: none at all, more than the 250 the
   commits API can return, or a fetched list that does not match the count the payload
   declared.
5. **Not already approved** — no APPROVE review from this App for the current head SHA.
6. **Still current** — the live pull request has not moved off the head SHA that was
   verified.

A **trusted principal** is one of:

- the owner of a personal repository, matched on both login and numeric user id;
- an organization owner (`role=admin`, `state=active` on the org membership API) for an
  organization repository;
- an allowed bot — `renovate[bot]`, `dependabot[bot]`, `autofix-ci[bot]` — matched on
  login, `type == "Bot"`, and numeric user id.

Any other account is untrusted, and a single commit from one blocks approval for the whole
pull request. `github-actions[bot]` is left out deliberately: it is not one actor but the
identity every workflow in the repository commits under, so trusting it would extend the
trust boundary to whatever any workflow does.

See [SPEC.md §3](SPEC.md#3-approval-conditions) for the full conditions and the reasoning
behind each one.

## How it works

```mermaid
flowchart TD
    GH["GitHub (pull_request webhook)"]
    API["GitHub REST API"]

    subgraph W["Cloudflare Workers (ghapprover)"]
        V["Verify webhook signature"]
        E["Evaluate approval conditions<br>(in-code constants + GitHub API)"]
        C["Re-check just before approving<br>(not already approved, head SHA unmoved)"]
        P["Post an APPROVE review<br>anchored to the verified head SHA"]
        V --> E --> C --> P
    end

    GH -->|"POST (signed with X-Hub-Signature-256)"| V
    E -->|"read the pull request and its commits"| API
    C -->|"read this App's reviews, re-read the pull request"| API
    P -->|"authenticated with an installation token"| API
```

| Component          | Role                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| GitHub App         | Delivers the webhooks and authenticates the API calls. Approvals appear under the App's bot user |
| Cloudflare Workers | The `POST /webhook` endpoint. Verifies, evaluates, and approves synchronously                    |
| Workers Secrets    | Storage for the App ID, private key, and webhook secret                                          |

Each delivery is handled synchronously, so its outcome is what GitHub records in Recent
Deliveries, and a failure can be retried by redelivering it by hand.

A delivery authored by the owner or an allowed bot costs under 10 API calls, against the 50
subrequests per request the Workers free plan allows. What can exhaust that allowance is a
pull request whose commits carry many _distinct_ principals, since each one costs a
membership lookup; such a delivery fails closed rather than approving.

## Prerequisites

- A Cloudflare account. The Workers free plan is enough for ordinary use — see
  [How it works](#how-it-works) for what a delivery costs against its limits.
- Permission to create a GitHub App on the target account (organization owner, for an
  organization).
- [mise](https://mise.jdx.dev/) — it installs the pinned Node, pnpm, and lint toolchain.
- `openssl`, to generate the webhook secret in step 2 and to convert the private key in
  step 3.

## Setup

### 1. Deploy the Worker

```sh
git clone https://github.com/takumin/ghapprover.git
cd ghapprover
mise run setup
mise run wrangler login   # or export CLOUDFLARE_API_TOKEN
mise run deploy
```

Note the URL wrangler prints (e.g. `https://ghapprover.<subdomain>.workers.dev`); it needs
the `workers.dev` subdomain enabled on the account. The webhook endpoint is that URL plus
`/webhook`.

The deployment has no secrets yet, so at this point it answers every delivery with
`missing-webhook-secret`. That is expected until step 4.

### 2. Create the GitHub App

Create a new GitHub App on the target user or organization account with:

**Permissions**

| Permission           | Access       | Purpose                                                |
| -------------------- | ------------ | ------------------------------------------------------ |
| Pull requests        | Read & write | Read the pull request and its commits, post the review |
| Organization members | Read         | Determine organization owners                          |
| Metadata             | Read         | Mandatory default permission                           |

**Events** — subscribe to `pull_request` only.

**Webhook** — set the URL to `https://<your-worker-url>/webhook`, and set a webhook
secret (generate one with `openssl rand -hex 32`). Keep it; step 4 needs it.

Then generate a private key and download the `.pem` file.

### 3. Convert the private key to PKCS#8

GitHub hands out App private keys in PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`), which
the Web Crypto API on Workers cannot import. Convert it once:

```sh
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in private-key.pem -out private-key-pkcs8.key
```

### 4. Store the secrets

```sh
mise run wrangler secret put GITHUB_APP_ID          # the App ID from the App's settings page
mise run wrangler secret put GITHUB_APP_PRIVATE_KEY # paste the PKCS#8 key, BEGIN/END lines included
mise run wrangler secret put GITHUB_WEBHOOK_SECRET  # the webhook secret from step 2
```

Nothing else is configurable, and nothing is read from environment variables — see
[Customization](#customization).

### 5. Install the App

Install the App on the target account, with one of:

- **Only select repositories** — the installation scope is the repository filter.
  Repositories outside it never receive a delivery and are never approved.
- **All repositories** — every repository, including ones created later. Per-repository
  control then lives in rulesets (step 6).

The installation scope is the only repository filter there is: ghapprover keeps no
allowlist of its own, and the §3 conditions ask about a pull request rather than about
which repository it is in. So the conditions do not narrow the scope — widening it to
**All repositories** is what decides that every qualifying owner or bot pull request in
each newly included repository, present and future, gets approved. Treat that as
granting a new approval path per repository, and pick the scope accordingly.

### 6. Configure branch protection or a ruleset

**Without this step ghapprover does nothing useful** — an approval that no rule requires
changes nothing. Configure, on each protected branch:

- **Require a pull request before merging**, with at least 1 required approval. This is
  the rule ghapprover exists to satisfy.
- **Require signed commits.** Approval requires `verification.verified` on every commit,
  so you must sign your own commits (a GPG or SSH key registered on GitHub) or commit via
  the web UI. This rule keeps everyday operation consistent with that requirement. Note
  that GitHub does not sign the commits it creates for the _rebase_ merge strategy — use
  squash or merge commits.
- **Dismiss stale pull request approvals when new commits are pushed.** ghapprover
  re-verifies and re-approves on every push, so with this on, a pull request stays
  approved only while all of its commits stay trusted.

If you installed with "All repositories" and some repositories must keep human review
required, set their required approvals to 2 or more, or require review from Code Owners
(the App's bot cannot be a code owner) — and do not add the owner or the App to the
bypass actors.

Details and caveats:
[SPEC.md §3.4](SPEC.md#34-prerequisite-branch-protection--ruleset-configuration-users-responsibility).

## Verifying the setup

Open a pull request from a branch in the repository itself, authored and signed by you,
and check that an APPROVE review appears from `<your-app-slug>[bot]`.

If it does not, work through it in this order:

1. **App settings → Advanced → Recent Deliveries.** No delivery at all means the App is
   not installed on that repository, or `pull_request` is not subscribed.
2. **The delivery's response.** The body carries `decision`, plus a `reason` on everything
   but an approval; the reason names the condition that stopped it. The two secret
   failures point at different secrets: `missing-webhook-secret` means step 4 never stored
   one on the deployment, while a 401 (`invalid-signature`) means the one it stored is not
   the one set in step 2.
3. **Workers Logs** (`mise run wrangler tail`, or the Cloudflare dashboard). Every outcome is
   logged with the delivery id, so grep by the id shown in Recent Deliveries. Diagnostic
   fields there separate a missing permission from a rate limit.

## Customization

There is no dynamic configuration. No KV, no environment variables, no runtime
configuration loading — every approval condition lives in the code and in Git history.

- **Allowed bots** are the `ALLOWED_BOTS` constant in `src/account.ts`, pairing each login
  with its numeric user id. To change them, edit the constant and redeploy. Repositories
  that do not run autofix.ci can drop that entry.
- **Target repositories** are controlled by the App's installation scope, and by rulesets
  when the scope is "All repositories".
- **Target branches** are not a control axis at all: `pull_request.base` is never read, so
  a pull request into a release branch is approved on the same terms as one into the
  default branch. Per-branch differences belong in rulesets.
- **Self-hosted Renovate** is not matched by design. The allowlist targets the Mend-hosted
  app's bot user; a self-hosted deployment runs under a different login and usually pushes
  unsigned commits over git.

## Security considerations

- **Who can get an approval**: only the trusted principals listed above. The check is a
  three-way branch, not a fallback chain, so a bot account is settled by the allowlist
  alone and a lookalike login is rejected without a lookup. Every identity exemption that
  _grants_ approval is pinned on a numeric id as well as a login.
- **Why signatures matter**: a commit's `author` and `committer` user objects are derived
  from its email addresses, so anyone with push access can forge them. Requiring
  `verification.verified` is what makes attribution mean anything — and it is why
  third-party commits pushed onto a trusted principal's branch block approval.
- **Fork pull requests are refused** before any API call. On a fork, write access to the
  head branch is not visible to the base repository, so the attribution argument above
  does not hold.
- **TOCTOU**: the live pull request is re-fetched immediately before the review is posted,
  and the approval is anchored to the verified head SHA. A residual window remains and is
  documented rather than papered over — see
  [SPEC.md §3.3](SPEC.md#33-race-condition-mitigation-toctou).
- **Secrets** live in Workers Secrets. Installation tokens are issued per delivery and
  never persisted; webhook signatures are compared in constant time; the request body is
  capped at 2 MiB before it is buffered.
- **Logs** stay inside your Cloudflare account and never carry tokens, keys, or payload
  values. Enabling Logpush or a Tail Worker forwards them elsewhere — treat that
  destination as part of the trust boundary first.

## Observability

Every delivery emits exactly one structured log entry to Workers Logs. Each field is
written as soon as it is known, so an entry says only as much as the delivery got far
enough to establish — which matters most for the early refusals, where looking for a
field that cannot be there reads as a missing log:

- `versionId`, the deployed version id, and a `decision` of `approved` / `skipped` /
  `error` are on every entry.
- `deliveryId` comes from the headers, ahead of every check, so it is there even on
  `missing-webhook-secret`, `payload-too-large` and `invalid-signature` — the entries
  whose only other identifier is the clock. It is absent when the header is, which is the
  ordinary case for `not-found`: such a request is usually not a delivery at all.
- `repo`, `prNumber`, `action` and `headSha` are read from the payload, so they exist
  only once the body has been signature-verified and parsed. The four refusals above and
  `invalid-payload` carry none of them; grep those by `deliveryId` and match it against
  Recent Deliveries.
- `reason`, drawn from a closed vocabulary, accompanies every outcome except an approval
  — for which the `approved` decision is the whole of it.

Failures add diagnostic fields: a failed API call carries the route template, status,
GitHub request id, and the accepted-permissions and rate-limit headers; an
`invalid-payload` carries `field`, the dot path of the payload field that failed
validation and the only thing that says which; and an `internal-error` carries
`errorName`, the thrown value's class, with the originating `errorMessage`.

The full reason vocabulary is in [SPEC.md §8](SPEC.md#8-observability); it is meant to be
grepped.

## Troubleshooting

| Symptom                                         | Likely cause                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| No delivery in Recent Deliveries                | The App is not installed on the repository, or `pull_request` is not subscribed                                  |
| `not-found`                                     | The webhook URL is missing the `/webhook` path                                                                   |
| `missing-webhook-secret`                        | `GITHUB_WEBHOOK_SECRET` is unset on the deployment                                                               |
| 401 / `invalid-signature`                       | The secret in Workers does not match the one in the App's settings                                               |
| `payload-too-large`                             | The body exceeded the 2 MiB cap the Worker buffers before verifying it                                           |
| `invalid-payload`                               | The body is not a `pull_request` event of the modeled shape — check the App's event subscription                 |
| `missing-installation`                          | The delivery carried no usable installation id — reinstall the App on the account                                |
| `internal-error` right after deploying          | The private key was stored in PKCS#1 — redo step 3                                                               |
| `event-out-of-scope` / `already-approved`       | Working as intended: an action outside the four handled, or an APPROVE from this App already covers the head SHA |
| `pr-draft` / `pr-not-open` / `head-repo-forked` | Working as intended: drafts, closed pull requests, and forks are never approved                                  |
| `head-repo-missing`                             | The head branch's repository was deleted before the delivery was evaluated                                       |
| `author-not-trusted`                            | The author is not the owner, an org owner, or an allowed bot                                                     |
| `unverified-commit`                             | A commit is unsigned — sign your commits, or commit through the web UI                                           |
| `untrusted-commit`                              | Someone outside the trust boundary authored or pushed a commit onto the branch                                   |
| `no-commits`                                    | The pull request declares zero commits, so there is nothing to verify — it fails closed                          |
| `too-many-commits`                              | More than 250 commits; the commits API cannot return them all, so it fails closed                                |
| `commit-count-mismatch`                         | The commits API returned a different number than the payload declared — redeliver, or push again                 |
| `head-moved`                                    | A push landed while the delivery was being evaluated; its own `synchronize` delivery approves the new head       |
| `review-rejected`                               | The pull request was closed or merged between the last check and the review POST                                 |
| `github-api-error` with 401                     | The App ID and the private key are not from the same App, so the App JWT was rejected — recheck step 4           |
| `github-api-error` with 403                     | Check `acceptedPermissions` in the log entry — a permission was never granted, or `rateLimitRemaining` is 0      |
| `github-api-error` with `status: 0`             | The call never reached GitHub, or the delivery spent its whole time budget — redeliver                           |
| Approved, but the merge is still blocked        | Another required check or a Code Owners review is unsatisfied — ghapprover only approves                         |

GitHub does not redeliver failed webhook deliveries automatically. After fixing a
configuration problem, redeliver by hand from Recent Deliveries, or push again. Doing so
is safe as often as you like: an APPROVE from this App already covering the head SHA
settles the redelivery as `already-approved` instead of reviewing again.

## Teardown

Undo step 6 first, in this order — otherwise the branch protection rule that ghapprover
was satisfying starts blocking your own pull requests the moment the Worker stops
answering.

1. **Branch protection or ruleset** — drop the required approval, or make it something you
   can satisfy by hand, on every branch configured in step 6.
2. **The GitHub App** — uninstall it from the account (Settings → Applications, or the
   organization's Installed GitHub Apps), which stops the deliveries. Then delete the App
   itself from its settings page if you do not intend to point it at another deployment;
   that revokes the private key too.
3. **The Worker**:

   ```sh
   mise run wrangler -- delete --dry-run   # confirm what it would remove
   mise run wrangler delete
   ```

   The stored secrets are part of the Worker, so they go with it — there is nothing to
   delete separately. Nothing else was provisioned: no KV namespace, no D1 database, no
   queue.

Deleting the Worker while the App is still installed is the wrong order but not dangerous:
deliveries just fail, and failing closed means nothing is approved.

## Development

```sh
mise run setup      # install dependencies
mise run test       # vitest, on the Workers runtime
mise run typecheck  # tsc over src and test
mise run format     # pinact + oxfmt
mise run lint-fix   # oxlint autofixes
mise run build      # bundle without deploying
mise run typegen    # regenerate worker-configuration.d.ts
mise run reviewdog  # every reviewdog runner (oxlint, actionlint, zizmor, ghalint, …)
mise run            # every CI gate, sequentially
mise run dev        # the Worker locally, with wrangler dev
mise run deploy     # deploy to Cloudflare
mise run wrangler … # any other wrangler subcommand (login, secret put, tail)
```

`mise run wrangler` forwards its arguments to wrangler as they are, but mise claims some
flags (`--help` among them) for itself. Separate them with `--` when passing any —
`mise run wrangler -- delete --dry-run`, while `mise run wrangler secret put NAME` needs
nothing.

Tests use
`@cloudflare/vitest-pool-workers`, so they execute against the real runtime rather than a
Node shim.

## Contributing

Issues and pull requests are welcome. Before opening one:

- Run `mise run` — it is the same set of gates CI runs.
- Write commit messages and pull request titles as
  [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), in English —
  imperative mood, lowercase description, no trailing period, subject within 72
  characters. Explain _why_ in the body, and mark a breaking change with `!` plus a
  `BREAKING CHANGE:` footer.
- Changes to approval behaviour need a matching change to [SPEC.md](SPEC.md), and to what
  this README restates of it — "What gets approved", "Security considerations", and the
  reason table under "Troubleshooting". The spec is normative; the code and this file both
  follow it.

## Documentation

[SPEC.md](SPEC.md) is the specification and the source of truth for everything above —
approval conditions, processing flow, error handling, observability, and the dependency
policy.

## License

[Apache-2.0](LICENSE)
