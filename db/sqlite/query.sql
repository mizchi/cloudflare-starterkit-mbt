-- sqlc query file. Run `pnpm run db:generate` to regen MoonBit
-- bindings into src/db/gen/. The post-gen patch in
-- scripts/patch-int64-binds.mjs wraps every Int64 / Int64? bind with
-- int64_bind_safe(...) so D1 never receives a JS BigInt.
--
-- Style rules enforced by scripts/check-sql-placeholder-mix.mjs:
--   - Do NOT mix anonymous `?` and `sqlc.arg(...)` in the same
--     statement. Pick one. Mixing makes sqlc-gen-moonbit emit
--     `?` and `?N` together, which under SQLite's "max+1" rule for
--     anonymous markers can land a trailing `?` on a number higher
--     than the bind-array length — D1 then errors out.

-- name: CreateItem :exec
INSERT INTO items (id, owner_user_id, title, body, created_at, updated_at)
VALUES (
  sqlc.arg('id'),
  sqlc.arg('owner_user_id'),
  sqlc.arg('title'),
  sqlc.arg('body'),
  sqlc.arg('created_at'),
  sqlc.arg('updated_at')
);

-- name: GetItemById :one
SELECT id, owner_user_id, title, body, created_at, updated_at
FROM items
WHERE id = sqlc.arg('id')
LIMIT 1;

-- name: ListItemsByOwner :many
SELECT id, owner_user_id, title, body, created_at, updated_at
FROM items
WHERE owner_user_id = sqlc.arg('owner_user_id')
ORDER BY updated_at DESC
LIMIT sqlc.arg('row_limit')
OFFSET sqlc.arg('row_offset');
