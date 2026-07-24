#!/usr/bin/env bash
# Preflight gate for Hollowmere.
#
# Verifies every CockroachDB capability the engine depends on BEFORE any
# retrieval code is written. Re-run this against CockroachDB Cloud in Phase 3 —
# Cloud defaults may differ from the local cluster.
#
# Usage:
#   ./scripts/preflight.sh                    # local docker cluster
#   DATABASE_URL=postgresql://... ./scripts/preflight.sh   # any cluster
set -uo pipefail

CRDB_IMAGE="${CRDB_IMAGE:-cockroachdb/cockroach:v26.2.4}"
DB="${PREFLIGHT_DB:-preflight_check}"
FAILURES=0

# Run SQL against either a supplied DATABASE_URL or the local docker cluster.
crdb_sql() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    docker run --rm -i "$CRDB_IMAGE" sql --url "$DATABASE_URL" "$@"
  else
    docker exec -i hollowmere-crdb1 ./cockroach sql --insecure "$@"
  fi
}

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == *"$expected"* ]]; then
    printf '  \033[32mPASS\033[0m  %s\n' "$name"
  else
    printf '  \033[31mFAIL\033[0m  %s\n        expected to contain: %s\n        got: %s\n' \
      "$name" "$expected" "$actual"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "Hollowmere preflight"
echo "===================="
echo

echo "Cluster"
check "server version >= v26" "v26" "$(crdb_sql -e 'SELECT version()' 2>&1 | tail -1)"
# crdb_internal is restricted in v26 without allow_unsafe_internals, and node
# count is meaningless on serverless anyway — so check it only locally, via CLI.
if [[ -z "${DATABASE_URL:-}" ]]; then
  live=$(docker exec hollowmere-crdb1 ./cockroach node status --insecure --format=tsv 2>/dev/null \
    | tail -n +2 | grep -c 'true$')
  check "3 live nodes (multi-node behaviour + node-kill demo)" "3" "$live"
fi
check "default isolation is serializable" "serializable" \
  "$(crdb_sql -e 'SHOW default_transaction_isolation' 2>&1 | tail -1)"

echo
echo "Vector indexing"
check "feature.vector_index.enabled" "t" \
  "$(crdb_sql -e 'SHOW CLUSTER SETTING feature.vector_index.enabled' 2>&1 | tail -1 | tr -d ' ')"

crdb_sql -e "DROP DATABASE IF EXISTS $DB CASCADE; CREATE DATABASE $DB;" >/dev/null 2>&1

ddl=$(crdb_sql -d "$DB" -e "
CREATE TABLE vtest (
  world_id UUID NOT NULL DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL DEFAULT gen_random_uuid(),
  embedding VECTOR(1024),
  PRIMARY KEY (world_id, memory_id)
);
CREATE VECTOR INDEX vtest_world_cos_idx ON vtest (world_id, embedding vector_cosine_ops);
" 2>&1 | tail -1)
check "VECTOR(1024) column + world-prefixed cosine index" "CREATE INDEX" "$ddl"

# The engine always sends the query vector as a literal/placeholder. A subquery
# defeats the ANN index entirely, so assert the shape we actually use.
VEC=$(python3 -c "
import random
random.seed(42)
print('['+','.join('%.6f'%random.random() for _ in range(1024))+']')
")

crdb_sql -d "$DB" -e "
INSERT INTO vtest (world_id, embedding)
SELECT ('00000000-0000-0000-0000-00000000000' || ((i % 2) + 1)::STRING)::UUID,
       ARRAY(SELECT random() FROM generate_series(1,1024))::VECTOR(1024)
FROM generate_series(1, 200) AS g(i);
ANALYZE vtest;
" >/dev/null 2>&1

# NOTE: without table statistics the optimizer ignores the vector index and
# falls back to a full scan + top-k. The engine must ANALYZE after bulk seeding
# and rely on auto-stats thereafter.
plan=$(crdb_sql -d "$DB" -e "
EXPLAIN SELECT memory_id FROM vtest
WHERE world_id = '00000000-0000-0000-0000-000000000001'
ORDER BY embedding <=> '$VEC'
LIMIT 10;" 2>&1)

check "ANN query uses the vector index" "vector search" "$plan"
check "ANN search is scoped per world (prefix spans)" "prefix spans" "$plan"

echo
echo "Time travel"
# The AOST target must post-date table creation, so let a little history accrue.
sleep 3
check "AS OF SYSTEM TIME query succeeds" "200" \
  "$(crdb_sql -d "$DB" -e "SELECT count(*) FROM vtest AS OF SYSTEM TIME '-2s'" 2>&1 | tail -1 | tr -d ' ')"
check "cluster_logical_timestamp() available" "." \
  "$(crdb_sql -e 'SELECT cluster_logical_timestamp()' 2>&1 | tail -1)"

gc=$(crdb_sql -e 'SHOW ZONE CONFIGURATION FROM RANGE default' 2>&1 | grep -o 'gc.ttlseconds = [0-9]*' | grep -o '[0-9]*')
echo "  INFO  gc.ttlseconds = ${gc:-unknown} ($(( ${gc:-0} / 3600 ))h AS OF SYSTEM TIME window)"

crdb_sql -e "DROP DATABASE IF EXISTS $DB CASCADE;" >/dev/null 2>&1

echo
if [[ $FAILURES -eq 0 ]]; then
  printf '\033[32mPreflight passed.\033[0m Retrieval work is unblocked.\n'
  exit 0
else
  printf '\033[31mPreflight FAILED (%d checks).\033[0m Do not start retrieval work.\n' "$FAILURES"
  exit 1
fi
