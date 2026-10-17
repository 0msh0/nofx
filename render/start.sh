#!/usr/bin/env bash
set -Eeuo pipefail

for variable in DB_HOST DB_USER DB_PASSWORD JWT_SECRET DATA_ENCRYPTION_KEY RSA_PRIVATE_KEY; do
    if [[ -z ${!variable:-} ]]; then
        echo "Missing required environment variable: $variable" >&2
        exit 1
    fi
done
[[ ${DB_TYPE:-postgres} == postgres ]] || { echo 'This deployment requires PostgreSQL.' >&2; exit 1; }
export PORT=${PORT:-10000} API_SERVER_PORT=8081
[[ $PORT =~ ^[0-9]+$ && $PORT -gt 0 && $PORT -lt 65536 && $PORT -ne 8081 ]] || {
    echo 'PORT must be a valid port other than the internal API port 8081.' >&2; exit 1;
}
export CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS:-${RENDER_EXTERNAL_URL:-}}
[[ -n $CORS_ALLOWED_ORIGINS ]] || { echo 'Set RENDER_EXTERNAL_URL or CORS_ALLOWED_ORIGINS.' >&2; exit 1; }
export PGHOST=$DB_HOST PGPORT=${DB_PORT:-5432} PGUSER=$DB_USER
export PGPASSWORD=$DB_PASSWORD PGDATABASE=${DB_NAME:-postgres}
export PGSSLMODE=${DB_SSLMODE:-require} PGCONNECT_TIMEOUT=15

# A dedicated role avoids collisions with Supabase Auth's auth.users table.
schema=$(psql -X -v ON_ERROR_STOP=1 -Atqc 'SELECT current_schema()')
[[ $schema == nofx ]] || {
    echo 'Database role must have search_path=nofx. Run render/supabase-bootstrap.sql first.' >&2
    exit 1
}

envsubst '${PORT}' < /app/render/nginx.conf.template > /etc/nginx/http.d/default.conf
nginx -t

backend_pid=''
nginx_pid=''
cleanup() {
    trap - EXIT TERM INT
    [[ -z $nginx_pid ]] || kill -QUIT "$nginx_pid" 2>/dev/null || true
    [[ -z $backend_pid ]] || kill -TERM "$backend_pid" 2>/dev/null || true
    [[ -z $backend_pid ]] || wait "$backend_pid" 2>/dev/null || true
    [[ -z $nginx_pid ]] || wait "$nginx_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT

/app/nofx &
backend_pid=$!
ready=false
for ((attempt=0; attempt<120; attempt++)); do
    kill -0 "$backend_pid" 2>/dev/null || { echo 'NOFX exited during startup.' >&2; exit 1; }
    if wget -q -O /dev/null http://127.0.0.1:8081/api/health; then
        ready=true
        break
    fi
    sleep 1
done
[[ $ready == true ]] || { echo 'NOFX startup timed out.' >&2; exit 1; }

# Backend ownership permits normal app access; browser database roles get none.
psql -X -v ON_ERROR_STOP=1 -f /app/render/protect-tables.sql
nginx -g 'daemon off;' &
nginx_pid=$!
echo "NOFX is ready on port $PORT."

# Exit when either process stops so Render can restart an unhealthy container.
set +e
wait -n "$backend_pid" "$nginx_pid"
status=$?
set -e
[[ $status -ne 0 ]] || status=1
exit "$status"
