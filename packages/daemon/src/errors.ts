import type { ErrorCode } from '@agentcats/protocol';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  internal: 500,
};

/** An error with a protocol error code, turned into an `ErrorResponse` by the server. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}
