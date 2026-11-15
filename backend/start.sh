#!/usr/bin/env bash
# All-in-one start for hosts that run a single container (no docker compose):
# migrations, then the API + web app (with the outbox publisher inside it) and the
# delivery worker side by side. If either process exits, the container exits so the
# platform restarts it.
#   RUN_MIGRATIONS=false   skip `alembic upgrade head` on start
#   RUN_WORKER=false       don't start the delivery worker here (it runs elsewhere)
#   PORT                   port to listen on (default 8000)
set -Eeuo pipefail

if [[ "${RUN_MIGRATIONS:-true}" == "true" ]]; then
  echo "start: running migrations"
  alembic upgrade head
fi

export RUN_PUBLISHER_IN_API="${RUN_PUBLISHER_IN_API:-true}"

pids=()
uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" \
  --proxy-headers --forwarded-allow-ips "*" &
pids+=($!)

if [[ "${RUN_WORKER:-true}" == "true" ]]; then
  python -m app.workers.delivery_worker &
  pids+=($!)
fi

stop() { kill -TERM "${pids[@]}" 2>/dev/null || true; wait || true; }
trap 'stop; exit 0' TERM INT

set +e
wait -n "${pids[@]}"
status=$?
echo "start: a process exited (status $status); stopping the container"
stop
exit "$status"
