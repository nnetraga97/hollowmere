-- Direct first-party read role.
--
-- Applied by `npm run db:roles`, which safely substitutes the quoted database
-- identifier below. This role is not the CockroachDB Cloud Managed MCP OAuth
-- identity; it exists for direct SQL read models and operator diagnostics.

CREATE ROLE IF NOT EXISTS hollowmere_reader LOGIN;

REVOKE ALL ON DATABASE {{DATABASE_NAME}} FROM hollowmere_reader;
REVOKE ALL ON SCHEMA public FROM hollowmere_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM hollowmere_reader;

GRANT CONNECT ON DATABASE {{DATABASE_NAME}} TO hollowmere_reader;
GRANT USAGE ON SCHEMA public TO hollowmere_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO hollowmere_reader;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO hollowmere_reader;
