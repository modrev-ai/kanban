#!/usr/bin/env sh
set -e

# Kanban binds to 0.0.0.0 inside the container (see KANBAN_RUNTIME_HOST), which
# puts it in "remote mode" and, by default, prints a one-time access passcode on
# startup. Set KANBAN_NO_PASSCODE=1 to disable that gate — only safe when the
# published port is not reachable by untrusted networks (e.g. bound to
# 127.0.0.1 on the host, or fronted by your own auth).
case "${KANBAN_NO_PASSCODE:-}" in
	1 | true | TRUE | yes)
		set -- "$@" --no-passcode
		;;
esac

exec "$@"
