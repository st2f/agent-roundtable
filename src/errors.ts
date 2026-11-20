/** Expected, user-facing error: the CLI prints the message (no stack) and exits 1. */
export class AskError extends Error {
  override name = "AskError";
}
