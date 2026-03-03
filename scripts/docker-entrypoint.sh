#!/usr/bin/env sh
set -eu

DATA_ROOT="${DATA_DIR:-/data}"
mkdir -p "$DATA_ROOT/uploads" "$DATA_ROOT/scans" "$DATA_ROOT/logs" "$DATA_ROOT/tmp"

if [ -n "${SANE_HOST:-}" ]; then
  printf "%s\n" "$SANE_HOST" > /etc/sane.d/net.conf
fi

exec "$@"
