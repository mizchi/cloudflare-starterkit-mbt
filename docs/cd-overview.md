# CD overview

Two automatic deploy paths, one reusable workflow under both.

```
push to main      ──► cd-staging.yml      ──┐
                                            │ uses: deploy.yml
push to release   ──► cd-production.yml   ──┘
```

`deploy.yml` is the single source of truth. The auto wrappers are thin and only differ in `environment:` and the deploy message.

## What `deploy.yml` does

1. **Checkout** + Node 24 + pnpm + MoonBit (with cache).
2. **Resolve env flags** — production = top-level wrangler config; staging = `--env staging`. Smoke base URL derives from worker name + `vars.WORKERS_SUBDOMAIN`.
3. **Capture pre-deploy version_id** — parses `wrangler deployments list` to remember what's currently live (for rollback). Detects the `10007 Worker does not exist yet` first-deploy case and emits `first_deploy=true` so the rollback step skips cleanly.
4. **Apply D1 migrations** — `wrangler d1 migrations apply` per DB. Auto-skips the prompt in CI; `--yes` is not a valid flag and will print help + exit 1 if you add it.
5. **Build** — moon → JS bundle + telemetry runtime + worker entrypoint.
6. **Deploy** — `wrangler deploy [--env staging]` with a commit-sha message.
7. **Smoke** — `pnpm run smoke` against the deployed URL. `continue-on-error: true` so step 8 always runs.
8. **Auto-rollback on smoke failure** — `wrangler rollback <captured version_id>`. Skipped on first deploy (no rollback target) and when `inputs.skip_rollback=true`.
9. **Report** — markdown summary in the GitHub Actions UI: env, pre / post version IDs, smoke result, whether rollback fired.
10. **Fail the job** if smoke failed — held until after report + rollback so the UI shows the full chain.

## .env.cloudflare contract

A single dotenvx-encrypted file is the source of truth for every Cloudflare credential. Repo only carries one secret: `DOTENV_PRIVATE_KEY_CLOUDFLARE` in GitHub Actions secrets. Rotating that one key effectively rotates every CF credential.

Required entries (set with `pnpm exec dotenvx set KEY VALUE -f .env.cloudflare`):

| Key | Used by |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | every `wrangler …` call |
| `CLOUDFLARE_ACCOUNT_ID` | wrangler scope; pulumi config |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | smoke against Access-gated prod |
| `CF_ACCESS_CLIENT_ID_STAGING` / `CF_ACCESS_CLIENT_SECRET_STAGING` | smoke against staging |
| `UTELS_INGEST_TOKEN` | server-side error tracking (per env) |
| `OTEL_EXPORTER_OTLP_HEADERS` | OTLP backend auth (Bearer / API-Key header) |

`wrangler.jsonc.vars` holds non-secret values inline. Secrets only enter the worker via `wrangler secret put` (one-off setup) or via the runtime env when launched through `dotenvx run`.

`dotenvx set KEY VALUE -f file` is **space-separated**, not `KEY=VALUE`. The wrong form errors out with "missing required argument 'value'".

## Manual deploy (hot fix)

```sh
gh workflow run deploy --ref <branch> -f environment=production
```

Inputs:
- `environment` — production | staging
- `skip_smoke=true` — emergency only; ship without verification
- `skip_rollback=true` — keep the new version even if smoke fails (so you can debug live)

Manual rollback (no deploy):

```sh
pnpm exec wrangler rollback <previous-version-id> [--env staging]
```

## What can go wrong (and how the workflow catches it)

| Symptom | Where caught | What to do |
| --- | --- | --- |
| First-time deploy on a fresh env | `pre_deploy.first_deploy=true` branch | nothing — rollback is skipped cleanly |
| Smoke fails on second+ deploy | `auto-rollback` step | previous version is live again before the workflow fails |
| dotenvx key is wrong | every `dotenvx run` step | step fails immediately; no Cloudflare API call made |
| Commit body contains shell metachars | `cd-staging.yml` uses `${{ github.sha }}` instead of `head_commit.message` | irrelevant — body never reaches the shell |
| Workflow not triggered after creating a new branch | new `release` branch with same tip as `main`: paths filter sees no diff | `gh workflow run deploy --ref release -f environment=production` once |

See [`docs/regression/worker-deploy.md`](regression/worker-deploy.md) for the complete trap list.
