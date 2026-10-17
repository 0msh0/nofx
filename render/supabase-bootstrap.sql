\set ON_ERROR_STOP on
\getenv nofx_db_password NOFX_DB_PASSWORD

-- Run once using an administrator connection. Supply NOFX_DB_PASSWORD through
-- the environment. CREATE ROLE intentionally fails if the role already exists.
BEGIN;
CREATE ROLE nofx_app LOGIN PASSWORD :'nofx_db_password'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT nofx_app TO postgres;
CREATE SCHEMA nofx AUTHORIZATION nofx_app;
REVOKE ALL ON SCHEMA nofx FROM PUBLIC, anon, authenticated;
GRANT CONNECT ON DATABASE postgres TO nofx_app;
ALTER ROLE nofx_app SET search_path = nofx;
ALTER DEFAULT PRIVILEGES FOR ROLE nofx_app IN SCHEMA nofx
    REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE nofx_app IN SCHEMA nofx
    REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE nofx_app IN SCHEMA nofx
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
COMMIT;
