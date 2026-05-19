-- Starter D1 schema. Apply with:
--   wrangler d1 execute cf-mbt-app --remote --file db/schema.sql
-- and create matching migrations in db/migrations/ (numbered 0001, 0002, …)
-- so `wrangler d1 migrations apply` can run them on every env.

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  -- Stored as INTEGER (unix ms). sqlc-gen-moonbit emits this as Int64
  -- on the MoonBit side; the int64_bind_safe wrapper in
  -- scripts/patch-int64-binds.mjs makes sure D1's .bind() never sees a
  -- raw BigInt (which would hang the .run() call).
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS items_owner_idx
  ON items(owner_user_id, updated_at DESC);
