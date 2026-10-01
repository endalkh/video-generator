-- Runs once, when the Postgres volume is first initialised.
-- The app's tables live in the `public` schema (DATABASE_URL uses ?schema=public).
-- The database is owned by POSTGRES_USER, so it can create tables in `public`;
-- we make that explicit and pin the search_path.
CREATE SCHEMA IF NOT EXISTS public;
ALTER SCHEMA public OWNER TO CURRENT_USER;
ALTER ROLE CURRENT_USER SET search_path TO public;
