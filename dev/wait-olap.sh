#!/bin/sh
# Waits until the given compose service (starrocks or doris) can create a table.
# The frontend answers queries well before that, and after a restart a backend
# says it is alive before it has reported its disks, so asking whether it is
# alive is not enough: tables are created here until one can be.
set -eu
service=$1
probe() {
  # The client stops at the first statement that fails.
  docker compose exec -T "$service" sh -c 'mysql -uroot -h127.0.0.1 -P9030' <<'SQL'
CREATE DATABASE IF NOT EXISTS supabi_wait;
DROP TABLE IF EXISTS supabi_wait.probe;
CREATE TABLE supabi_wait.probe (id int) DUPLICATE KEY(id) DISTRIBUTED BY HASH(id) BUCKETS 1 PROPERTIES ("replication_num" = "1");
DROP DATABASE supabi_wait;
SQL
}
for _ in $(seq 1 120); do
  if probe >/dev/null 2>&1; then
    exit 0
  fi
  sleep 3
done
echo "$service did not become ready" >&2
exit 1
