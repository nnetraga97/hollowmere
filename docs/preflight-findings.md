# Preflight findings — CockroachDB v26.2.4

Verified by `./scripts/preflight.sh` against the local 3-node cluster on 2026-07-24.
Re-run this gate against CockroachDB Cloud in Phase 3; several defaults below may differ.

## Confirmed capabilities

| Capability | Result |
|---|---|
| Server version | **v26.2.4** (well past the v25.2 vector-index release) |
| `feature.vector_index.enabled` | **`true` by default** — no opt-in needed locally |
| `VECTOR(1024)` columns | Supported (matches Titan Text Embeddings V2) |
| `CREATE VECTOR INDEX` | Supported, runs as a background job |
| World-prefixed vector index | **Supported** — `(world_id, embedding vector_cosine_ops)` |
| Per-world ANN scoping | Confirmed: plan shows `vector search` + `prefix spans` bounded to one `world_id` |
| Distance operators | `<->` L2, `<=>` cosine, `<#>` inner product |
| Default isolation | `serializable` |
| `AS OF SYSTEM TIME` | Works |
| `cluster_logical_timestamp()` | Available — use for recording commit timestamps |
| `gc.ttlseconds` | **14400 (4 h)** — the AS OF SYSTEM TIME window |

## Constraints that change how the engine must be written

These are not test artifacts. Each one silently degrades behaviour rather than erroring.

### 1. The distance metric is fixed at index creation, via opclass
`SHOW CREATE TABLE` records the opclass — the default is `vector_l2_ops`. A `<=>`
(cosine) query will **not** use an `l2` index.

> **Rule:** memory embedding indexes are created with `vector_cosine_ops`, and
> retrieval queries use `<=>`. The two must match.

### 2. The query vector must be a literal or placeholder — never a subquery
With the search vector supplied as a scalar subquery, the optimizer produces a
full primary-key scan + `top-k` and ignores the index entirely.

```sql
-- IGNORES the index
ORDER BY embedding <=> (SELECT embedding FROM ... LIMIT 1)

-- USES the index
ORDER BY embedding <=> $1
```

> **Rule:** the engine embeds the query text first, then passes the vector as a
> bound parameter. Never join or subquery to obtain it.

### 3. Table statistics are required for the index to be chosen
On a freshly seeded table with no stats, the plan falls back to a full scan
(`missing stats`). After `ANALYZE`, the same query uses `vector search`.

> **Rule:** `ANALYZE` the memory table after world seeding; rely on auto-stats
> thereafter. Retrieval performance tests must assert the plan, not just the
> result — a correct-but-unindexed query passes a result assertion silently.

### 4. `crdb_internal` is restricted in v26
`SELECT ... FROM crdb_internal.*` fails with SQLSTATE `42501` unless
`allow_unsafe_internals = true` is set.

> **Impact:** observability (Section 8 of the plan) cannot read `crdb_internal`
> tables by default. Use supported surfaces — the DB Console, the `cockroach`
> CLI (`node status`), and our own `world_tick_commits` / `world_budget`
> instrumentation — rather than internal tables.

### 5. New tables are created with `schema_locked = true`
This is a v26 default. Declarative schema changes handle it automatically, but
migration tooling that performs unusual DDL may need to unlock first.

## Consequences folded into the plan

- Retrieval builds a **bound-parameter cosine query against a world-prefixed
  `vector_cosine_ops` index**, and its test asserts the query plan.
- Seeding ends with `ANALYZE`.
- Observability avoids `crdb_internal`.
- The 4 h GC window comfortably covers a 30 min world plus the demo, so the
  `AS OF SYSTEM TIME` resilience demonstration stays inside it. Product history
  still comes from tick-indexed append-only tables, not time travel.
