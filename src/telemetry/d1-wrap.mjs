// D1 query telemetry: Proxy-wrap pattern for env.* D1 bindings.
//
// Each `prepare → bind → first/run/all/raw` chain anywhere in the
// codebase is timed via `recorder` without any call-site changes. The
// SQL template is threaded through bind() returns so the eventual
// terminal op records the right statement.
//
// Public surface:
//   wrapD1Bindings(env, recorder) -> wrapped env
//     • walks every property on env, wraps any value with a
//       `prepare()` method as a D1 binding
//   d1QuerySpan(spanCtx, query, { toKeyValues, randomHex })
//     -> OTLP child span object for one recorded query
//   d1SlowThreshold(env) -> threshold ms (env-overridable)
//
// Helpers exported for testing: detectDbOperation, detectDbTable,
// truncateStatement.

export const DEFAULT_D1_SLOW_THRESHOLD_MS = 200;
export const D1_STATEMENT_MAX_LEN = 500;

function nowNs() {
  return String(BigInt(Date.now()) * 1_000_000n);
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function truncateStatement(sql) {
  const s = String(sql ?? "");
  return s.length > D1_STATEMENT_MAX_LEN
    ? s.slice(0, D1_STATEMENT_MAX_LEN) + "..."
    : s;
}

export function detectDbOperation(sql) {
  const m = String(sql ?? "").trimStart().match(
    /^(SELECT|INSERT|UPDATE|DELETE|UPSERT|WITH|CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT|ROLLBACK)\b/i,
  );
  return m ? m[1].toUpperCase() : "OTHER";
}

export function detectDbTable(sql) {
  const m = String(sql ?? "").match(
    /\b(?:FROM|INTO|UPDATE|JOIN)\s+["`]?(\w+)["`]?/i,
  );
  return m ? m[1] : undefined;
}

export function d1SlowThreshold(env) {
  const raw = typeof env?.APP_D1_SLOW_THRESHOLD_MS === "string"
    ? env.APP_D1_SLOW_THRESHOLD_MS
    : undefined;
  if (!raw) return DEFAULT_D1_SLOW_THRESHOLD_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_D1_SLOW_THRESHOLD_MS;
}

export function wrapD1PreparedStatement(stmt, sql, bindingName, recorder) {
  return new Proxy(stmt, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop === "bind") {
        return (...args) =>
          wrapD1PreparedStatement(
            target.bind(...args),
            sql,
            bindingName,
            recorder,
          );
      }
      if (prop === "first" || prop === "run" || prop === "all" ||
          prop === "raw") {
        return async (...args) => {
          const startNs = nowNs();
          const startMs = nowMs();
          let ok = true;
          try {
            return await value.apply(target, args);
          } catch (e) {
            ok = false;
            throw e;
          } finally {
            recorder({
              bindingName,
              op: prop,
              sql,
              startNs,
              endNs: nowNs(),
              durationMs: Math.max(0, nowMs() - startMs),
              ok,
            });
          }
        };
      }
      return value.bind(target);
    },
  });
}

export function wrapD1Database(db, bindingName, recorder) {
  if (!db || typeof db !== "object" || typeof db.prepare !== "function") {
    return db;
  }
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop === "prepare") {
        return (sql) => {
          const stmt = target.prepare(sql);
          return wrapD1PreparedStatement(stmt, sql, bindingName, recorder);
        };
      }
      if (prop === "batch") {
        return async (statements) => {
          const startNs = nowNs();
          const startMs = nowMs();
          let ok = true;
          try {
            return await value.apply(target, [statements]);
          } catch (e) {
            ok = false;
            throw e;
          } finally {
            recorder({
              bindingName,
              op: "batch",
              sql: `BATCH(${statements?.length ?? 0})`,
              startNs,
              endNs: nowNs(),
              durationMs: Math.max(0, nowMs() - startMs),
              ok,
            });
          }
        };
      }
      if (prop === "exec") {
        return async (sql) => {
          const startNs = nowNs();
          const startMs = nowMs();
          let ok = true;
          try {
            return await value.apply(target, [sql]);
          } catch (e) {
            ok = false;
            throw e;
          } finally {
            recorder({
              bindingName,
              op: "exec",
              sql,
              startNs,
              endNs: nowNs(),
              durationMs: Math.max(0, nowMs() - startMs),
              ok,
            });
          }
        };
      }
      return value.bind(target);
    },
  });
}

export function wrapD1Bindings(env, recorder) {
  if (!env || typeof env !== "object") return env;
  const wrapped = { ...env };
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (
      value && typeof value === "object" && typeof value.prepare === "function"
    ) {
      wrapped[key] = wrapD1Database(value, key, recorder);
    }
  }
  return wrapped;
}

/// Build an OTLP child span object for one recorded query.
/// `toKeyValues` and `randomHex` come from the OTLP-layer helpers in
/// the parent module — passed as deps to keep this file self-contained.
export function d1QuerySpan(spanCtx, query, { toKeyValues, randomHex }) {
  const table = detectDbTable(query.sql);
  const op = detectDbOperation(query.sql);
  return {
    traceId: spanCtx.traceId,
    spanId: randomHex(8),
    parentSpanId: spanCtx.spanId,
    name: table ? `d1.${op.toLowerCase()} ${table}` : `d1.${op.toLowerCase()}`,
    kind: 3, // CLIENT
    startTimeUnixNano: query.startNs,
    endTimeUnixNano: query.endNs,
    attributes: toKeyValues({
      "db.system": "cloudflare.d1",
      "db.operation": op,
      "db.statement": truncateStatement(query.sql),
      ...(table ? { "db.sql.table": table } : {}),
      "app.d1.binding": query.bindingName,
      "app.d1.method": query.op,
      "app.d1.duration_ms": query.durationMs,
    }),
    ...(query.ok ? {} : { status: { code: 2 } }),
  };
}
