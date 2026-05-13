# Postgres Reference

Column conventions used in this project:

- Primary keys are `bigint generated always as identity`.
- Timestamps are `timestamptz` and always store UTC.
- Soft deletes use a nullable `deleted_at` column.
- Enums prefer Postgres `CHECK` constraints over `CREATE TYPE`.

Common indexes:

- `(deleted_at) WHERE deleted_at IS NULL` for partial-active filters.
- BRIN on append-only `created_at` columns over 10M rows.
