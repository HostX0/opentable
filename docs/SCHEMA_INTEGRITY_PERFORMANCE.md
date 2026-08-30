## Schema integrity + performance pass

This change set focuses on making the visual schema editor safe on real-world databases and cheap to inspect on large tables.

### Performance

- Avoid exact `COUNT(*)` when opening table structure on PostgreSQL/MySQL and use catalog estimates instead.
- Surface approximate row counts and table/index size metadata where available.
- Build schema column lookup maps once instead of repeatedly filtering the full column list per table.
- Fetch independent PostgreSQL metadata in parallel where possible.

### Correctness / data preservation

- Preserve exact PostgreSQL/MySQL column type information rather than collapsing types such as `varchar(255)` or `numeric(12,2)`.
- Preserve composite foreign keys and their `ON UPDATE` / `ON DELETE` actions.
- Preserve SQLite indexes, including partial/expression indexes, across table rebuilds.
- Preserve custom PostgreSQL primary-key constraint names.
- Treat primary-key column renames as renames instead of unnecessary key replacement.
- Order dependent FK/index teardown before destructive column changes.
- Rewrite renamed identifiers without rewriting string literals inside index predicates.

### UX

- Mark estimated row counts with `~` rather than presenting metadata estimates as exact.
- Show table size when the server can provide it cheaply.

The goal is that opening or editing a large/complex table never silently downgrades its schema and does not run an expensive full-table count just to render the Structure tab.
