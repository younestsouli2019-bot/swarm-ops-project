/**
 * Next.js instrumentation hook — runs once per server instance, before
 * any route handler is invoked.
 *
 * We use this entry point to install the log scrubber so every
 * console.log / .error / .warn call across the entire server has
 * secrets masked before hitting stdout/stderr.
 *
 * See src/lib/log-scrubber.ts for the scrubbing rules.
 */

export async function register() {
  // Only run on the server (not in the Edge build).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installLogScrubber } = await import("./src/lib/log-scrubber");
    installLogScrubber();
  }
}
