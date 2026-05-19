# cloudflare-starterkit-mbt

Opinionated starter kit for a Cloudflare Worker written in **MoonBit**, backed by **D1** through **sqlc-gen-moonbit**, provisioned with **Pulumi**, and shipped through a **dotenvx**-encrypted env + **GitHub Actions** CD pipeline with auto-rollback on smoke failure.

Distilled from a real-world worker; every piece exists because skipping it left an actual production scar.

## What's in the box

```
.
├── src/
│   ├── main.mbt                 # minimal mars-based worker handler
│   ├── telemetry-runtime.mjs    # OTLP + utels error tracking wrappers
│   ├── telemetry/d1-wrap.mjs    # D1 Proxy: slow-query log + per-query spans
│   └── db/gen/                  # sqlc output (generated; do not edit)
├── db/
│   ├── schema.sql               # canonical schema
│   ├── sqlite/query.sql         # sqlc queries (named params only)
│   └── migrations/              # `wrangler d1 migrations apply`
├── scripts/
│   ├── prepare-worker.mjs       # bundles moon JS + emits dist/worker.mjs
│   ├── patch-int64-binds.mjs    # wraps Int64 binds with int64_bind_safe
│   ├── check-sql-placeholder-mix.mjs
│   ├── check-worker-bundle.mjs
│   └── smoke.mjs                # post-deploy HTTP probes
├── infra/pulumi/                # Cloudflare D1 + R2 + Access stack
├── .github/workflows/
│   ├── ci.yml                   # build + db:verify on PR
│   ├── deploy.yml               # reusable; deploy → smoke → rollback
│   ├── cd-staging.yml           # push to main → staging
│   └── cd-production.yml        # push to release → production
└── wrangler.jsonc               # top-level=prod; env.staging block
```

## Quickstart

```sh
# 1. Use this template (or clone)
gh repo create my-app --template mizchi/cloudflare-starterkit-mbt --public
cd my-app

# 2. Install dependencies
pnpm install
moon install

# 3. Provision Cloudflare resources via Pulumi
cd infra/pulumi
cp Pulumi.example.yaml Pulumi.dev.yaml          # edit account ID + emails
pulumi stack init dev
pulumi up
# Copy stack outputs into ../../wrangler.jsonc (database_id) and
# ../../.env.cloudflare (Access AUD, team domain, service-token creds).

# 4. Set up encrypted Cloudflare env
cp ../../.env.cloudflare.example ../../.env.cloudflare
pnpm exec dotenvx set CLOUDFLARE_API_TOKEN <token> -f ../../.env.cloudflare
# ... repeat for all needed values
pnpm exec dotenvx encrypt -f ../../.env.cloudflare

# 5. Apply schema + ship
cd ../..
pnpm exec wrangler d1 execute cf-mbt-app --remote --file db/schema.sql
pnpm run build
pnpm run deploy
```

After this, push to `main` deploys staging automatically, and `git push origin main:release` ships production. Both runs include post-deploy smoke and auto-rollback on smoke failure.

## Rename for your app

Replace `cf-mbt-app` everywhere with your own name. Files to touch:

- `package.json` (`name`, `description`)
- `moon.mod.json` (`name`, `description`, `repository`)
- `wrangler.jsonc` (`name`, all D1/R2 binding names, `vars.OTEL_SERVICE_NAME`, `vars.UTELS_PROJECT_ID`)
- `scripts/prepare-worker.mjs` (moonOutput filename, app-core.js filename, `__appServerFetch` global if you renamed it)
- `src/telemetry-runtime.mjs` (`DEFAULT_SERVICE_NAME`, `SCOPE.name`)
- `infra/pulumi/*` (resource names, the `cf-mbt-app` strings, Pulumi project name)
- `.github/workflows/deploy.yml` (the `cf-mbt-app` strings in env / smoke base / migrations DB list)

`grep -rn "cf-mbt-app" .` will land them all.

## Why these specific choices

- **MoonBit + mars** for the worker: typed handlers, async/await without callback hell, generated JS is small.
- **sqlc-gen-moonbit** for D1 access: typed query bindings; never write raw `.bind([...])` in handler code. Every Int64 column needs the `int64_bind_safe` wrapper because D1's `.bind()` hangs on JS BigInt — `scripts/patch-int64-binds.mjs` enforces this, and `--verify` is a CI gate.
- **dotenvx** for `.env.cloudflare`: one repo secret rotates every Cloudflare credential. `wrangler` reads them through `dotenvx run -f .env.cloudflare -- wrangler …`.
- **Pulumi** for D1 / R2 / Access: declarative + state-managed, but `wrangler vectorize create` stays manual because the cloudflare provider (v6.x) lacks `VectorizeIndex`.
- **utels** for error tracking: lighter than Sentry, integrates as a single `fetch` boundary at the worker entrypoint (server-side only — browser SDK is out of scope here).
- **OTLP** for traces / metrics / logs: any backend that speaks OTLP/HTTP/JSON works (Honeycomb, Grafana Cloud, Tempo).
- **Auto-rollback on smoke failure**: the only reliable way to catch production-only bugs (BigInt hangs, missing env, region-only routing) without a human in the loop.

## Docs

- [`docs/cd-overview.md`](docs/cd-overview.md) — the full CI/CD chain, what each step does, and where to look when it breaks.
- [`docs/telemetry.md`](docs/telemetry.md) — OTLP + utels wiring, env vars, disabling per-env.
- [`docs/regression/worker-deploy.md`](docs/regression/worker-deploy.md) — Cloudflare Workers + wrangler + GitHub Actions trap collection. Read this before you spend an afternoon on `1101`.

## License

MIT. See [LICENSE](LICENSE).
