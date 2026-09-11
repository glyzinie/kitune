#!/bin/sh
set -eu
umask 077
mkdir -p /data
chown -R bun:bun /data
chmod 700 /data
if [ -f "$CONFIG_PATH" ]; then
  chown root:bun "$CONFIG_PATH"
  chmod 640 "$CONFIG_PATH"
fi
exec gosu bun "$@"
