# infralabs-claude-pipeline

GitHub Actions orchestration for InfraLabs IQ invoice OCR with the Claude Code CLI. This repo is public and holds
only workflows and two small bash scripts. The InfraLabs code and the prompt live in the private repo
`nestacktechnologies/InfralabsIQ`, which every run checks out into `app/`.

## Quick start (Hinglish)

Ye repo sirf orchestration hai: har uploaded PDF ke liye ek GitHub Actions run, jo private InfralabsIQ repo
checkout karke `aws/run-one.ts` chalata hai. OCR Claude CLI karta hai (Mistral ki jagah), baaki pipeline wahi hai.

1. GitHub pe naya **public** repo banao, ye code `main` pe push karo (workflow files default branch pe hone chahiye).
2. `claude setup-token` chalao (browser login, token 1 saal chalta hai, kahin save nahi hota), phir
   `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R <owner>/infralabs-claude-pipeline` mein paste karo.
3. Baaki secrets aur vars neeche ke tables se set karo. `INFRALABS_REF` mein commit SHA ya tag do, branch nahi.
4. Platform (EC2 `web.env`) pe `INVOICE_GITHUB_REPO` aur `INVOICE_GITHUB_TOKEN` (sirf is repo pe Actions: write)
   set karke restart karo. Ab har PDF upload yahan ek run dispatch karega.
5. Test: ek QA invoice upload ya Reprocess karo, Actions tab mein `invoice <upload id>` run dekho. Summary mein sirf
   counts aate hain, invoice ka data kabhi nahi.
6. Yaad rakho: token 1 saal mein expire hota hai (reminder lagao), aur public repo mein 60 din bina commit ke cron
   band ho jata hai. Client production ke liye `ANTHROPIC_API_KEY` safer hai (neeche "Subscription or API key").

## How it works

```
Platform (EC2, Next.js)                      GitHub Actions (this repo)
-----------------------                      --------------------------
POST /api/invoices, or Reprocess
  PDF: ProcessingJob PENDING,
       kind github-actions,
       errorMessage gh-dispatched:<t>
  workflow_dispatch {upload_id, lane} ---->  process-invoice.yml  (run-name "invoice <id>",
                                               one bill at a time per lane, 350 min cap)
                                               1  validate inputs, JOB_STARTED_AT
                                               2  check out this repo (scripts/)
                                               3  Runnable? (mysql through scripts/db.sh)
                                               4  check out InfralabsIQ into app/
                                               5-8  Node 22, npm ci, fonts, Claude CLI (pinned)
                                               9  node --import tsx aws/run-one.ts <id>
                                                    claim, kept pages -> claude -p -> markdown,
                                                    then the usual parse, classify, records
                                               10 summary (counts only)
                                               11 always(): a stopped run -> failed
                                               12 result: 0 and 75 green, 3 and 1 red

parent.yml, every 30 min: scripts/sweep.sh
  lost or failed dispatches, ended deferrals ----> gh workflow run process-invoice.yml

Data: RDS MySQL (job rows), S3 (the raw PDF, pages read so far in <raw>.claude.json), Anthropic (claude -p)
```

The platform dispatches every new PDF itself. Only PDFs come here, because the OCR is the part that moved to Claude:
Excel, CSV and Word files stay on SQS or inline.

The job row carries the state, in `ProcessingJob.errorMessage` (never shown in the UI):

| Marker | Meaning |
|---|---|
| `gh-dispatched:<unix s>` | A run was dispatched at that time. The sweep re-dispatches it after 15 min if no run for it is queued or running. |
| `gh-dispatched:0` | The platform's dispatch failed: the next sweep takes it. |
| `claude-deferred:<unix s>` | run-one handed the job back until then (Claude usage limit reset, time budget, or pages to retry). The pages read so far are saved in S3, and the next run resumes from them. |
| `runner crash: <error>` | run-one crashed. Only in the private database, never in the public log. |

`ProcessingJob.bullJobId` holds `gh:<run id>/<attempt>` of the run that claimed the job; the cleanup step keys on it.

## Setup

### 1. The repo

- Public repo, default branch `main`, Actions enabled. Push this code.
- Settings > Actions > General: "Fork pull request workflows from outside collaborators": require approval for all
  outside collaborators. Workflow permissions: read repository contents.

### 2. The Claude token

```bash
REPO=<owner>/infralabs-claude-pipeline
claude setup-token                                 # browser login; prints a token valid for 1 year, saves nothing
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R "$REPO"   # paste it at the prompt, so it never lands in shell history
```

Mint it from the account that should carry the usage, not someone's day to day login. For an API key instead, set
`ANTHROPIC_API_KEY` the same way (see "Subscription or API key").

### 3. Secrets

Set each with `gh secret set <NAME> -R "$REPO"`.

| Secret | Required | Value |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | yes, or `ANTHROPIC_API_KEY` | From `claude setup-token`. |
| `ANTHROPIC_API_KEY` | optional | API key billing. Wins over the OAuth token when both are set, so set only one. |
| `DATABASE_URL` | yes | The platform's `mysql://` URL (special characters percent-encoded, as the platform has it). |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | yes | S3 access to the raw invoice prefix. |
| `AWS_S3_BUCKET` | yes | The bucket name. A secret, because step env blocks print variables in clear text. |
| `INFRALABS_REPOSITORY` | yes | `nestacktechnologies/InfralabsIQ` (a secret for the same reason). |
| `INFRALABS_REF` | yes | Commit SHA or tag of InfralabsIQ to run. Not a branch: a push must not change what runs mid-queue. |
| `INFRALABS_REPO_TOKEN` | yes | Fine-grained token, only that repo, Contents: Read-only. |
| `GOOGLE_GMAIL_CLIENT_ID`, `GOOGLE_GMAIL_CLIENT_SECRET`, `GMAIL_TOKEN_ENCRYPTION_KEY` | for team mail | Same values as the platform, or the stored Gmail token cannot be decrypted. |
| `OPENAI_API_KEY` | optional, recommended | Keeps the LLM passes the Mistral baseline had (invoice check, header enrichment, line normalization). Without it the generic LLM parser is switched off. |

### 4. Variables

Set each with `gh variable set <NAME> -R "$REPO" --body <value>`.

| Variable | Default | Value |
|---|---|---|
| `AWS_REGION` | `ap-southeast-2` | Region of the bucket. |
| `AWS_S3_RAW_INVOICES_FOLDER` | `raw-pdf` | Raw invoice prefix. |
| `APP_URL` | none | Platform URL, used for the links in team emails. |
| `CLAUDE_OCR_MODEL` | `claude-sonnet-5-5` | First read model. Re-reads use the retry model set in InfralabsIQ (Opus by default). |
| `CLAUDE_CLI_VERSION` | `2.1.295` | Exact `@anthropic-ai/claude-code` version: at least 2.1.293, and at least two weeks old. |
| `LANES` | `2` | Bills processed in parallel. Keep equal to the platform's `INVOICE_GITHUB_LANES`. |
| `CLAUDE_AI_RECOVERY` | `true` | AI recovery of flagged services, run with Claude. |

### 5. Tokens

- `INFRALABS_REPO_TOKEN`: fine-grained personal access token, resource owner `nestacktechnologies`, only the
  `InfralabsIQ` repository, repository permission Contents: Read-only. The organization must allow fine-grained tokens
  and may have to approve it. A read-only deploy key (`ssh-key:` on the checkout step) is the alternative that does not
  expire.
- `INVOICE_GITHUB_TOKEN` (on the platform, not here): fine-grained token, only this repository, repository permission
  Actions: Read and write. Nothing else.

### 6. The platform

On the EC2 web server (`web.env`), then restart:

| Env | Default | Value |
|---|---|---|
| `INVOICE_GITHUB_REPO` | none | `<owner>/infralabs-claude-pipeline`. Setting it turns GitHub mode on for PDFs. |
| `INVOICE_GITHUB_TOKEN` | none | The Actions: write token above. |
| `INVOICE_GITHUB_WORKFLOW` | `process-invoice.yml` | |
| `INVOICE_GITHUB_REF` | `main` | Branch of this repo the workflow runs from. |
| `INVOICE_GITHUB_LANES` | `2` | Keep equal to `LANES` here. |

`INVOICE_QUEUE_URL` can stay: then only non-PDF files go to SQS. For each PDF the platform writes the job row first,
then dispatches; a failed dispatch is logged and marked `gh-dispatched:0`, and the next sweep picks it up.

## Test it

1. Pick a QA upload whose job is `PENDING` with kind `github-actions`. The platform makes it so in GitHub mode: upload a
   PDF or press Reprocess. That already dispatches a run; to dispatch one by hand:

   ```bash
   gh workflow run process-invoice.yml -R "$REPO" -f upload_id=<upload id> -f lane=0
   gh run watch -R "$REPO"
   ```

2. The run is named `invoice <upload id>`. Its summary shows the status, pages, calls, re-reads and minutes. The
   invoice then shows up in the platform for review.
3. A run for an upload in any other state ends green at "Nothing to do: <state>" without touching it.
4. `gh workflow run parent.yml -R "$REPO"` runs the sweep once; its summary shows the counts.

## Exit codes

From `aws/run-one.ts` (step "Process invoice"), turned into the run's colour by the "Result" step:

| Exit | Meaning | Run | What happens next |
|---|---|---|---|
| 0 | Done, or nothing to claim (already taken, done, deferred, gone). | green | Nothing. |
| 75 | Deferred: Claude usage limit, the time budget, or pages to retry. | green | Job back to `PENDING` with `claude-deferred:<t>`; the sweep dispatches it after `<t>` and the new run resumes from the saved pages. |
| 3 | Configuration: Claude login or billing, model, CLI version, or a secret not set. | red | Fix the config. A missing secret stops the run before the claim, so the upload waits and the sweep retries it. A Claude login, model or version error fails the upload with the real message: Reprocess it after the fix. |
| 1 | run-one crashed, or the CLI preflight failed. | red | A crash leaves `runner crash: ...` on the job, and the cleanup step marks the upload failed: Reprocess resumes from the saved pages. A preflight failure leaves the job untouched, and the sweep retries it. |

Cancelling a run (or the 350 min cap) signals run-one, which hands the job back like a deferral; whatever it could not
hand back, the cleanup step marks failed with "Runner stopped (time cap or crash): reprocess to resume from the saved
pages". To stop an invoice for good, fail or delete it in the platform.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Nothing to do: not-pending` | The job is not `PENDING` `github-actions`: already processed, claimed by another run, or the upload was processed before GitHub mode. Reprocess it on the platform. |
| `Nothing to do: deferred` | Waiting for the Claude reset time; the sweep dispatches it when due. |
| `Nothing to do: not-in-flight` or `missing` | The upload is no longer processing, or was deleted. |
| `db query failed (exit 1, mysql ERROR 1045)` | Wrong user or password in `DATABASE_URL`. Copy the platform's URL as is. |
| `mysql ERROR 2003` or `2005` | The database host is not reachable from GitHub runners (RDS public access, security group on 3306). |
| `mysql ERROR 2026` | TLS failed. `db.sh` requires TLS (`ssl-mode=REQUIRED`). |
| `mysql ERROR 1044` or `1142` | The database user lacks a privilege. |
| `DATABASE_URL is not set or not a mysql:// URL` | The secret is missing or malformed. |
| "Check out InfralabsIQ" fails | `INFRALABS_REPO_TOKEN` expired or lacks Contents: Read on the repo, the organization has not approved it, or `INFRALABS_REF` does not exist. |
| Every run ends red with exit 3 | The setup token expired (1 year) or was revoked, or `CLAUDE_OCR_MODEL` / `CLAUDE_CLI_VERSION` is wrong. Run `claude setup-token` again and update the secret, then Reprocess the failed uploads. |
| Many runs stay queued | Each lane runs one bill at a time (and holds up to 100 waiting). Raise `LANES` and `INVOICE_GITHUB_LANES` together, keeping the shared Claude usage in mind. |
| The parent sweep stopped running | 60 days without repository activity disables cron in a public repo. Actions > Parent sweep > Enable workflow, or push a commit. |
| An upload failed with "Runner stopped (time cap or crash)" | The bill did not finish in 350 min, or run-one crashed. Reprocess resumes from the saved pages. |
| Where is the full log? | Never published: it stays on the runner and is deleted with it. The reason is on the job row (`ProcessingJob.errorMessage`) and in AuditLog (`processing.claude_ocr`, `processing.failed`). To debug a bill, run `aws/run-one.ts` locally against a QA database (see `docs/claude-pipeline.md` in InfralabsIQ). |

## Security notes

- **Logs are public.** Any signed-in GitHub user can read the run logs and summaries of a public repo. The workflows
  print only counts, statuses and the opaque upload id. run-one writes its own log (file names, services, amounts) to
  `$RUNNER_TEMP/run.log`, which is never printed or uploaded, and there are no artifacts. Keep it that way: no
  `cat run.log`, no `upload-artifact`, no `set -x`.
- **Triggers.** Only `workflow_dispatch` and `schedule`. Never add `pull_request` or `pull_request_target`: a pull
  request from a fork must never run next to these secrets. Only people with write access can dispatch a run.
- **Secrets.** `db.sh` masks every part of `DATABASE_URL` before anything can print it, keeps it in a 0600 file under
  `$RUNNER_TEMP` and hides mysql's error text (it names the host and the user). The bucket and the private repo name
  are secrets, because env blocks print variables in clear text. `DATABASE_URL` reaches only the three steps that
  query the database; the app secrets reach only the "Process invoice" step.
- **Claude has no tools.** Invoice text is untrusted input. run-one starts `claude -p` with no tools, no MCP servers,
  an empty working directory and an allowlisted environment without database or AWS credentials (see
  `src/lib/claude/cli.ts` in InfralabsIQ).
- **Pinned code.** Actions are pinned by full commit SHA, the Claude CLI by exact version, and InfralabsIQ by
  `INFRALABS_REF`.
- **Database.** Hosted runners have no fixed IP addresses, so RDS has to accept 3306 from the internet (it already
  does). Give the pipeline its own least-privilege user that requires TLS:

  ```sql
  CREATE USER 'gh_pipeline'@'%' IDENTIFIED BY '<long random password>' REQUIRE SSL;
  GRANT SELECT, INSERT, UPDATE, DELETE ON `<database>`.* TO 'gh_pipeline'@'%';
  ```

  `db.sh` connects with `ssl-mode=REQUIRED`: encrypted, but the server certificate is not verified. To verify it, add
  `ssl-ca` (the RDS global bundle) and `ssl-mode=VERIFY_IDENTITY` to `db.sh`, and the matching Prisma TLS options to
  `DATABASE_URL`. Better still, later: a self-hosted runner inside the VPC, or a platform callback API, so no runner
  holds database credentials.
- **AWS.** Static keys for now: scope the IAM user to the raw invoice prefix of the bucket (GetObject, PutObject,
  DeleteObject). Later, GitHub OIDC (`id-token: write`) with a role that trusts only this repo's default branch
  removes the keys altogether.

## Subscription or API key

`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` bills the Claude subscription of whoever created it. Anthropic
documents that token for a person's own use of Claude Code, CI included, and asks products and services built for
other people to use API key authentication; it does not allow routing other people's requests through Free, Pro or Max
plan credentials. Running a client's production invoice processing on a subscription token may fall in that case, and
the account can be limited or suspended without notice. This is not legal advice.

For production, set `ANTHROPIC_API_KEY` instead. Nothing else changes: the CLI picks it up and uses it ahead of the
OAuth token, so set only one of the two. The run's audit row (`processing.claude_ocr`) records which one was used
(`apiKeySource`).

## Maintenance

- **Setup token: 1 year.** It does not refresh. Put a reminder 11 months out. When it expires, runs fail with a Claude
  login error (exit 3) and the affected uploads need Reprocess once the new token is set.
- **Fine-grained tokens expire** too (`INFRALABS_REPO_TOKEN` here, `INVOICE_GITHUB_TOKEN` on the platform): same reminder.
- **60 days of inactivity.** GitHub disables scheduled workflows in a public repo after 60 days without repository
  activity. The platform's own dispatch keeps working, but lost dispatches and ended deferrals stop being retried. A
  commit, or re-enabling the workflow, resets the clock.
- **New InfralabsIQ version:** update `INFRALABS_REF`.
- **New CLI version:** run the accuracy bench on it first, then update `CLAUDE_CLI_VERSION`.

## Cost notes

- **GitHub:** standard hosted runners are free for public repos (4 vCPU, 16 GB). Each run spends a few minutes on setup
  (npm ci, fonts, the CLI) before the first page. A private repo would pay for minutes and get a smaller runner; check
  the 12 GB Node heap set in "Process invoice" first.
- **Claude on a subscription:** no bill per call, but every page counts against the account's 5-hour and weekly limits,
  shared with anyone using the same account interactively. A limit defers the run and it resumes after the reset, so a
  backlog drains at the subscription's pace.
- **Claude on an API key:** billed per token. A page is mostly its image plus the text layer (a few thousand input
  tokens) and the JSON output; re-reads use the retry model. The bench prints calls, tokens and the CLI's cost estimate
  per bill: measure on real bills before switching.
- **Mistral OCR** (what this replaces): about $4 per 1000 pages.

## Accuracy

Accuracy is measured in the private repo, not here: `aws/ocr-bench.ts` in InfralabsIQ compares Claude and Mistral on
saved bills, offline (no database, S3, Mistral or OpenAI calls). Per bill and engine it reports money recall and
precision against the PDF text layer, the reconciliation delta, records to check, and the workbook truth for the
reference bill, in `bench-out/report.md` and `report.json`. Run it on the runner's CLI version:
`npm i --prefix <dir> @anthropic-ai/claude-code@2.1.295` and `CLAUDE_BIN=<dir>/node_modules/.bin/claude`. Details in
`docs/claude-pipeline.md` there.
