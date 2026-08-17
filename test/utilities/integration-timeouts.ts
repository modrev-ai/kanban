const isWindows = process.platform === "win32";

/**
 * How long to wait for a spawned Kanban runtime to print its startup banner.
 *
 * Integration tests boot the runtime from TypeScript source through tsx, which
 * recompiles the entry graph in every spawned process. On Windows that costs ~10s
 * even with a warm cache and appreciably more cold — so the previous flat 10s bound
 * raced startup and failed with an empty stdout *and* empty stderr, which reads like
 * a runtime that crashed silently rather than one that simply had not finished
 * booting. `scripts/dev-full.mjs` allows 60s for the same startup path.
 *
 * This is a failure bound, not a cost: a healthy server resolves as soon as it prints.
 */
export const RUNTIME_START_TIMEOUT_MS = isWindows ? 60_000 : 15_000;

/**
 * Per-test budget for cases that spawn one or more runtimes, sized so the startup
 * cost above cannot eat the whole allowance on the slowest platform.
 */
export const RUNTIME_INTEGRATION_TEST_TIMEOUT_MS = isWindows ? 180_000 : 45_000;

/**
 * How long a one-shot `kanban <command>` invocation gets to run and exit. These pay
 * the same tsx compile as the runtime above, so they need the same headroom.
 */
export const CLI_COMMAND_TIMEOUT_MS = isWindows ? 45_000 : 8_000;
