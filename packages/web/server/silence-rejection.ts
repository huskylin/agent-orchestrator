// Preloaded via NODE --require BEFORE Next.js starts.
// Suppresses transient unhandledRejection from SSE streams (controller closed
// when the client disconnects), preventing them from crashing the Node process.
// Without this, a single SSE client disconnect crashes the entire dashboard.

console.error("[silence-rejection] preload loaded, installing handler");

process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (
    message.includes("Controller is already closed") ||
    message.includes("Invalid state")
  ) {
    return;
  }
  console.error("[unhandledRejection]", reason);
});
