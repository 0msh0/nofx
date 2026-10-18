# NOFX on Render with Supabase

The Render service serves the frontend and Go API at one HTTPS URL. Supabase
stores application data in a private `nofx` schema with a dedicated `nofx_app`
role. NOFX keeps its existing login system. Supabase Auth is not used.

The deployment image now builds the backend and frontend from this branch, so
application changes deploy with the Render service. The pinned official frontend
image supplies only the licensed `charting_library` runtime assets required by the
source frontend build. This avoids depending on access to the upstream private
chart-library repository during Render builds.

## Database setup

Choose a Supabase project. As its database administrator, run
`supabase-bootstrap.sql` with `psql` 15 or newer, setting `NOFX_DB_PASSWORD` to a
fresh, random password through your environment. This creates a new role and
schema; it intentionally stops if that role or schema already exists.

Use Supabase's **Connect → Session pooler** values in Render:

| Variable | Value |
| --- | --- |
| `DB_HOST` | Exact pooler host shown by Supabase; do not infer it from the region |
| `DB_PORT` | `5432` |
| `DB_USER` | `nofx_app.PROJECT_REF` |
| `DB_PASSWORD` | Password created for `nofx_app` |
| `DB_NAME` | `postgres` |
| `DB_SSLMODE` | `require` |

Keep `nofx` out of Supabase's exposed Data API schemas. Never supply the project
administrator credentials to the Render service. Tables are created by NOFX at
startup, and startup enables RLS on existing NOFX tables. Tables created later
remain protected by the private schema and default privileges.

## Render setup

Create a Blueprint from this fork, branch `deploy/render-supabase`, using
`render.yaml`. It creates one **free** web service and no Render database. Free
services can sleep after inactivity and are unsuitable for guaranteed continuous
trading. This repository includes `.github/workflows/render-keepalive.yml`, which
requests `/health` every ten minutes after you add the deployment origin as the
GitHub Actions secret `RENDER_KEEPALIVE_URL`. It reduces idle sleep risk but does
not override Render's free-tier limits or guarantee continuous availability.

Render generates persistent `JWT_SECRET` and `DATA_ENCRYPTION_KEY` values. NOFX
accepts Render's random encryption secret and derives its AES key from it. Supply
a persistent RSA private key in the secret `RSA_PRIVATE_KEY` variable. Generate
one locally with `openssl genrsa 2048`; enter the complete PEM value in Render.
Do not regenerate encryption secrets on restart or redeployment; back them up
securely so existing encrypted credentials remain readable.

`RENDER_EXTERNAL_URL` supplies the default CORS origin. When adding a custom
domain, set `CORS_ALLOWED_ORIGINS` to your HTTPS origins separated by commas.
Render provides HTTPS; the internal API runs on port 8081. `/health` checks the
API, and the container exits if the API or nginx stops. Use a single instance
and stop running traders before manually deploying a replacement instance.

After deployment, verify `/health`, `/api/config`, `/planning`, and
`/charting_library/charting_library.standalone.js`, then create your owner account
at the deployment URL. Configure models and exchanges through NOFX after login.

## Local verification

`bash render/verify.sh` builds the exact deployment image and checks PostgreSQL
startup, schema isolation, frontend assets, registration, and restart persistence
using disposable Docker containers. It requires a running Docker engine.
