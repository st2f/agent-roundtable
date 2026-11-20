/** Expected, user-facing error: the CLI prints the message (no stack) and exits with exitCode. */
export class AskError extends Error {
  override name = "AskError";
  readonly exitCode: number;

  constructor(message: string, options?: { exitCode?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.exitCode = options?.exitCode ?? 1;
  }
}
