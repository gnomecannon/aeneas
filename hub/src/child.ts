import type { ChildProcess } from "node:child_process";

/**
 * Give a child process its standard input and close it. A child that finishes before reading it (a `command -v`
 * that answers at once, an ssh that cannot connect) closes the pipe, and the write then fails with EPIPE; without a
 * listener that error is uncaught and stops the whole hub. The child's exit code already says what happened, so
 * the failed write is ignored.
 */
export function feedStdin(child: ChildProcess, data: string | undefined | null): void {
  if (!child.stdin) return;
  child.stdin.on("error", () => {});
  child.stdin.end(data ?? "");
}
