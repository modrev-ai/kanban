# Production Runtime Connection Errors

Triage notes for two errors observed on the `dev` branch running against a real
workspace. Both are teardown-path bugs: the runtime was tearing connections and locks
down *abruptly* where it should have closed them *gracefully*, so the operator saw a
transport-level symptom instead of the actual reason.

Read this before "fixing" either error by silencing the log line.

---

## 1. `[vite] ws proxy error: Error: read ECONNRESET`

```
1:17:36 AM [vite] ws proxy error:
Error: read ECONNRESET
    at TCP.onStreamRead (node:internal/stream_base_commons:216:20)
```

### Topology

The web UI is served by Vite, which proxies `/api` to the runtime with `ws: true`
([web-ui/vite.config.ts](../../web-ui/vite.config.ts)):

```
browser  ──ws──▶  Vite dev server (4173 / 4174)  ──ws──▶  runtime (3484 / 3485)
                       ▲
                       └── logs "ws proxy error" when either side resets
```

`npm run dev:full` pins 3484/4173 and `npm run prod:full` pins 3485/4174; both go
through [scripts/dev-full.mjs](../../scripts/dev-full.mjs), so **both run behind the
Vite proxy** and both can produce this line.

Three WebSocket endpoints cross that proxy:

| Path | Server |
| --- | --- |
| `/api/runtime/ws` | [runtime-state-hub.ts](../../src/server/runtime-state-hub.ts) |
| `/api/terminal/io` | [ws-server.ts](../../src/terminal/ws-server.ts) |
| `/api/terminal/control` | [ws-server.ts](../../src/terminal/ws-server.ts) |

### Root cause

`ECONNRESET` is not a Vite bug and it is not a network problem on loopback. It means
the runtime sent a TCP **RST** — it *aborted* the connection rather than closing it.
The runtime did that in two families of places, and in both the RST destroyed
information the operator needed.

**a. Rejected WebSocket upgrades were aborted, not answered.**

Every upgrade passes a Host/Origin gate (`handleSocketUpgrade` in
[middleware.ts](../../src/server/middleware.ts)), and unrecognised upgrade paths fall
through to a catch-all listener in
[runtime-server.ts](../../src/server/runtime-server.ts). Each rejection did:

```ts
socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
socket.destroy();   // ← RST: discards the status line that was just written
```

`destroy()` immediately after `write()` does not flush. The 403/401 never reached the
peer, so:

- **Vite** could only report `ws proxy error: Error: read ECONNRESET`.
- **The browser** saw close code `1006` (abnormal closure), indistinguishable from a
  runtime crash.
- **The runtime** logged nothing at all.

An upgrade rejection that is invisible on all three sides is undiagnosable, which is
why this sat unexplained.

The gate rejects for real, reachable reasons:

- The browser stamps `Origin: http://<host>:<web-ui-port>` on the WebSocket handshake.
  Vite's `changeOrigin: true` rewrites only the **Host** header — the `Origin` header
  is forwarded untouched unless `rewriteWsOrigin: true` is also set. So the runtime
  sees the *Vite* origin, not its own.
- `evaluateCors` accepts that Vite origin only through a dev escape hatch that requires
  **both** `NODE_ENV === "development"` **and** `KANBAN_WEB_UI_PORT` to match the port
  the browser actually used.
- Therefore: opening the UI on a LAN address or hostname instead of
  `localhost`/`127.0.0.1`, or running the runtime with a non-development `NODE_ENV`,
  makes every WebSocket upgrade fail this gate — silently, as a connection reset.

**b. Shutdown terminated sockets instead of closing them.**

Both `close()` paths did `client.terminate()`, which skips the WebSocket close
handshake and aborts the TCP connection. Every runtime restart — and `dev:full` /
`prod:full` run under `tsx watch`, so restarts are constant — reset every open
WebSocket and printed this error.

**c. Latent crash: the gate ran twice and could reject twice.**

`runtime-state-hub` and the terminal bridge each register an `upgrade` listener, so
`handleSocketUpgrade` ran twice per request. On a rejection the second call wrote to an
already-destroyed socket. Node attaches no `'error'` listener to a raw upgrade socket,
so that surfaces as an **unhandled `'error'` event** — an uncaught exception that kills
the runtime, which in turn resets every other WebSocket. This had not been positively
observed in prod, but it is reachable from any rejected upgrade.

### Fix

- `endUpgradeSocket(socket, statusLine)` in
  [middleware.ts](../../src/server/middleware.ts) writes the status line, half-closes
  with FIN so it is actually delivered, and destroys only after the flush completes. It
  also attaches a no-op `'error'` listener first, so a peer that vanishes mid-handshake
  cannot crash the process. Every `socket.destroy()` in an upgrade path now goes
  through it, with a meaningful status: `400` malformed, `401` passcode, `403`
  Host/Origin, `404` unknown path.
- Rejections now log the reason on the runtime side
  (`[runtime-server] rejected websocket upgrade: Origin … not allowed.`).
- `handleSocketUpgrade` memoizes its decision on the request object, so the gate is
  evaluated once and a rejection is written once.
- `closeWebSocketsForShutdown`
  ([websocket-shutdown.ts](../../src/server/websocket-shutdown.ts)) sends a real close
  frame (`1001 going away`) and only falls back to `terminate()` for clients that do
  not answer within 250 ms. Used by both the terminal bridge and the runtime state hub.

### How to diagnose it now

The reset is no longer the only evidence. Check, in order:

1. **Runtime stderr** — a `rejected websocket upgrade:` line names the offending Host
   or Origin. That is the answer; fix the origin or the port, not the proxy.
2. **Browser devtools → Network → WS** — the failed handshake now shows a real
   `401`/`403`/`404` status instead of a dead connection.
3. **No runtime log and no HTTP status** — then it is case (b): the runtime restarted
   or exited underneath the proxy. Look for a crash or a `tsx watch` reload.

### Residual, expected occurrences

A runtime that is **killed** (`SIGKILL`, crash, `treeKill` from `dev-full.mjs`) cannot
send close frames, so Vite will still log one `ws proxy error` per open socket. That is
correct behaviour reporting a real event — do not filter it out of the Vite logger.

### If the Origin gate is the problem

Pick one, in preference order:

1. Open the UI at `http://localhost:<web-ui-port>` or `http://127.0.0.1:<web-ui-port>`
   with `NODE_ENV=development` and `KANBAN_WEB_UI_PORT` matching that port. This is what
   `dev:full` / `prod:full` already configure.
2. Skip the proxy: run `npm run build` and let the runtime serve the built UI from
   `dist/web-ui` on its own port, so Origin and Host are both the runtime's own.
3. Add `rewriteWsOrigin: true` to the `/api` proxy entry in `vite.config.ts` so Vite
   rewrites the WS `Origin` to the target. Only do this knowingly — it makes the
   runtime's CSRF/DNS-rebinding origin check unenforceable for proxied WebSockets.

---

## 2. `[locked-file-system] failed to release lock (ignoring): EBUSY … rmdir '<path>.lock'`

```
[locked-file-system] failed to release lock (ignoring): EBUSY: resource busy or locked,
rmdir 'G:\Shared drives\…\config\workspaces\index.json.lock'
```

### Root cause

A `proper-lockfile` lock is a **directory**: acquired with `mkdir` (atomic), released
with `rmdir`. `proper-lockfile` retries neither. On Windows — and far more often on a
virtual synced filesystem like Google Drive File Stream (`G:\Shared drives\…`) — the
sync agent, search indexer, or antivirus still holds a handle on the directory that was
just created and touched, so the `rmdir` fails with `EBUSY`/`EPERM`.

The log line was only the symptom. The damage is that **the lock directory survives**.
Its mtime refresher has already stopped, so the next writer of that file cannot acquire
the lock until it ages past the 10 s `stale` threshold and gets stolen. Every write to
that file after an `EBUSY` release stalls for up to 10 seconds.

### Fix

`proper-lockfile` accepts a pluggable `options.fs`.
[lockfile-fs.ts](../../src/fs/lockfile-fs.ts) supplies an adapter whose
`rmdir`/`rmdirSync` route through `node:fs`'s `rm`/`rmSync` with
`recursive` + `force` + `maxRetries`/`retryDelay` — Node's own linear backoff over
`EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`, `EPERM` — instead of a hand-rolled loop. It is
wired in by `createLockOptions` in
[locked-file-system.ts](../../src/fs/locked-file-system.ts).

Budgets: 8 × 50 ms for the async release (~1.8 s worst case, comfortably inside the 10 s
stale window), 3 × 20 ms for the process-exit release, which busy-waits and delays
shutdown.

Two constraints worth keeping:

- The adapter must be a **module-level singleton**. `proper-lockfile`'s mtime-precision
  probe caches its result keyed on the fs object's identity; a fresh object per lock
  re-probes (an extra `utimes` + `stat`) on every acquisition.
- `recursive: true` is required because `fs.rm` refuses directories without it. That is
  safe here only because the path is always the `.lock` directory `proper-lockfile`
  derived from the target file — never user data. Do not reuse this adapter elsewhere.

### Known limitation

File locking on Google Drive File Stream is fundamentally unreliable: `proper-lockfile`
depends on `mkdir` atomicity and on `utimes` mtime propagation, and a virtual filesystem
with an asynchronous sync agent guarantees neither. If two machines write the same
shared config concurrently, a lost update is still possible regardless of this fix. The
atomic temp-file + rename write in `writeTextFileAtomic` bounds the worst case to a lost
update of a rebuildable JSON file, never a corrupt or partial one. If cross-machine
concurrency is a real requirement, a synced drive is the wrong substrate for the state
directory.

---

## Shared lesson

Both bugs had the same shape: **the abrupt teardown destroyed the diagnostic**. An RST
discards the HTTP status that explains a refusal; an un-retried `rmdir` leaves a lock
that makes the *next* operation look slow. When writing a teardown path, ask what the
peer — or the next caller — will be able to observe.

Relevant tests:

- [test/runtime/server/middleware.test.ts](../../test/runtime/server/middleware.test.ts)
- [test/runtime/server/websocket-shutdown.test.ts](../../test/runtime/server/websocket-shutdown.test.ts)
- [test/runtime/lockfile-fs.test.ts](../../test/runtime/lockfile-fs.test.ts)
- [test/runtime/locked-file-system.test.ts](../../test/runtime/locked-file-system.test.ts)
