// Next.js instrumentation hook — runs once at server startup, before any route handler.
// https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
//
// Purpose: install a global unhandledRejection handler that swallows the
// "Controller is already closed" errors thrown by SSE streams when clients
// disconnect mid-flight. Without this, a single such error crashes the
// entire Next.js server (Node default behavior since v15).

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  console.error("[ao-instrumentation] installing unhandledRejection handler");

  // Remove any pre-installed handlers (Next.js installs one that crashes the process)
  process.removeAllListeners("unhandledRejection");

  process.on("unhandledRejection", (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (
      message.includes("Controller is already closed") ||
      message.includes("Invalid state")
    ) {
      // SSE client disconnected — expected, swallow.
      return;
    }
    console.error("[unhandledRejection]", reason);
  });
}
