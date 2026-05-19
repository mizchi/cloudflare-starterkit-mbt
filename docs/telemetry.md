# Telemetry

Two independent layers, wired at the same boundary (`dist/worker.mjs`):

1. **OTLP traces / metrics / logs** via `withTelemetry`. Pushes to any OTLP/HTTP/JSON backend (Honeycomb, Grafana Cloud, Tempo, Jaeger collector, …).
2. **utels error tracking** via `withUtelsErrorTracking`. Self-host-able Sentry alternative; ingests one `exception` event per 5xx or thrown exception.

Both wrappers are no-op pass-throughs unless their env vars are present. You can run with neither, just one, or both.

## OTLP

Enable by setting an endpoint:

```sh
pnpm exec dotenvx set OTEL_EXPORTER_OTLP_ENDPOINT "https://api.honeycomb.io" -f .env.cloudflare
pnpm exec dotenvx set OTEL_EXPORTER_OTLP_HEADERS "x-honeycomb-team=<key>" -f .env.cloudflare
```

The endpoint can be the collector base (`https://host`) or any of the three per-signal endpoints (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, etc.). Headers go in `OTEL_EXPORTER_OTLP_HEADERS` as comma-separated `k=v` pairs.

Resource attributes default to `service.name=cf-mbt-app` / `service.version=0.1.0` / `deployment.environment=<DEPLOY_ENV>` — override via the matching env vars in `wrangler.jsonc.vars`.

Per-request span: `<METHOD> <route>` with `http.*`, `url.*`, `server.address`, `user_agent.original`, plus `app.d1.{query_count,slow_count,max_duration_ms}`. Each D1 query becomes a child span with `db.system=sqlite`, `db.operation`, `db.sql.table`, `db.statement` (truncated). Routes are normalized in `routeForPath` to keep cardinality bounded — edit that function before adding routes with high-cardinality params.

Disable temporarily without removing the env vars: `OTEL_SDK_DISABLED=true` or `APP_TELEMETRY_DISABLED=true`.

## utels error tracking

Set `UTELS_ENDPOINT`, `UTELS_PROJECT_ID`, and `UTELS_RELEASE` in `wrangler.jsonc.vars` (per env), and `UTELS_INGEST_TOKEN` as a wrangler secret (`wrangler secret put UTELS_INGEST_TOKEN [--env staging]`). The wrapper stays inert until all three are present.

Event shape: a single `name: "exception"` payload per 5xx response or uncaught throw, with `runtime: "node"`, `runtimeVersion: "cloudflare-workers"`, a fingerprint derived from error type + message + top stack frame, and one HTTP breadcrumb. Matches the utels v1 ingest schema.

Disable: `UTELS_DISABLED=true` (no secret rotation needed).

### Bootstrap

If you're using `utels.dev`, run the registration API to create a project per env and pipe the returned ingest token to `wrangler secret put`. See the utels docs for the `/api/registration?v=1` contract — the token never needs to land in logs (pass it via the spawned `wrangler` child's stdin).

## Slow-query telemetry

`withTelemetry` always wraps every D1 binding with a Proxy that logs `event: "d1.slow_query"` to `console.warn` whenever a query exceeds `APP_D1_SLOW_THRESHOLD_MS` (default 250). The warning includes `binding`, `op`, `operation`, `table`, `duration_ms`, and a truncated `statement`. `wrangler tail` picks them up immediately; the same data lands as a child span when OTLP is also wired.

This runs even without OTLP configured so you can spot slow queries from a fresh `wrangler tail` session.
