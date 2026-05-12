export class OperationAbortedError extends Error {
  constructor(message = "Operation aborted.") {
    super(message);
    this.name = "OperationAbortedError";
  }
}

export function isOperationAbortedError(error: unknown): error is OperationAbortedError {
  return error instanceof OperationAbortedError;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new OperationAbortedError();
  }
}
