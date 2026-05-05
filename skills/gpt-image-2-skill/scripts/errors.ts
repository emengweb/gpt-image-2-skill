export class CliError extends Error {
  code: string;
  detail?: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.detail = detail;
  }
}

export function asError(error: unknown) {
  if (error instanceof CliError) return error;
  if (error instanceof Error) {
    return new CliError("runtime_error", error.message);
  }
  return new CliError("runtime_error", String(error));
}
