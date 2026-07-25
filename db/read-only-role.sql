-- Read-only role.
--
-- Used by the debug dashboard and, in Phase 3, by the Managed MCP Server that
-- powers the Town Investigator. Both of those surfaces answer questions about a
-- world; neither has any business changing one, and the safest way to say so is
-- to hand them a login that cannot.
--
-- This is least privilege in the literal sense: the dashboard does not "avoid"
-- writing, it is unable to. An accidental UPDATE in a read model, or a prompt
-- that talks the Investigator into one, fails at the database.
--
--   cockroach sql --insecure -d hollowmere -f db/read-only-role.sql
--   DATABASE_URL=postgresql://hollowmere_reader@host:26257/hollowmere node web/server.ts

CREATE ROLE IF NOT EXISTS hollowmere_reader LOGIN;

GRANT CONNECT ON DATABASE hollowmere TO hollowmere_reader;
GRANT USAGE ON SCHEMA public TO hollowmere_reader;

-- SELECT on everything that exists now...
GRANT SELECT ON ALL TABLES IN SCHEMA public TO hollowmere_reader;

-- ...and on everything added later, so a new table is not accidentally
-- invisible to the dashboard or, worse, granted more than SELECT by hand.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO hollowmere_reader;

-- Explicitly withhold the rest. CockroachDB does not grant these by default;
-- stating it makes the intent auditable rather than incidental.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public
  FROM hollowmere_reader;
