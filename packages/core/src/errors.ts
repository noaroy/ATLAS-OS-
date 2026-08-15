/**
 * A single error taxonomy for the whole platform.
 *
 * Every failure that crosses a module boundary is an `AtlasError` so that the
 * API, the logs, and the village alert state all classify it the same way.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'DEPENDENCY_FAILED'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'TOOL_DENIED'
  | 'PROVIDER_ERROR'
  /**
   * Un plafond économique refuse l'appel *avant* qu'il parte.
   *
   * Distinct de `TOOL_DENIED` : rien n'est interdit ici, il n'y a plus de
   * budget. Toujours non-réessayable — réessayer coûterait exactement ce que
   * le refus vient d'éviter.
   */
  | 'BUDGET_EXCEEDED'
  /** Une étape n'a pas reçu l'entrée qu'elle déclare exiger. */
  | 'PRECONDITION_UNMET'
  | 'INTERNAL';

const HTTP_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE: 409,
  DEPENDENCY_FAILED: 502,
  TIMEOUT: 504,
  RATE_LIMITED: 429,
  TOOL_DENIED: 403,
  PROVIDER_ERROR: 502,
  BUDGET_EXCEEDED: 402,
  PRECONDITION_UNMET: 428,
  INTERNAL: 500,
};

export class AtlasError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  /** Whether a supervisor may reasonably retry the operation. */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: unknown; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AtlasError';
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.details = options.details;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(code);
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

const DEFAULT_RETRYABLE = new Set<ErrorCode>([
  'DEPENDENCY_FAILED',
  'TIMEOUT',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
]);

export const badRequest = (message: string, details?: unknown) =>
  new AtlasError('BAD_REQUEST', message, { details });
export const unauthorized = (message = 'Authentication required') =>
  new AtlasError('UNAUTHORIZED', message);
export const forbidden = (message = 'Not permitted') => new AtlasError('FORBIDDEN', message);
export const notFound = (what: string) => new AtlasError('NOT_FOUND', `${what} not found`);
export const conflict = (message: string) => new AtlasError('CONFLICT', message);
export const invalidState = (message: string) => new AtlasError('INVALID_STATE', message);
export const timeout = (message: string) => new AtlasError('TIMEOUT', message);
export const internal = (message: string, cause?: unknown) =>
  new AtlasError('INTERNAL', message, { cause });

/** Normalises anything thrown into an `AtlasError` without losing the cause. */
export function toAtlasError(err: unknown): AtlasError {
  if (err instanceof AtlasError) return err;
  if (err instanceof Error) return new AtlasError('INTERNAL', err.message, { cause: err });
  return new AtlasError('INTERNAL', String(err));
}

/** Short, human-readable message safe to show in the UI and event log. */
export function describeError(err: unknown): string {
  const e = toAtlasError(err);
  return `${e.code}: ${e.message}`;
}
