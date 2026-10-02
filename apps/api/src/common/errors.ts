import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Standardised API error: `{ "error": "MATCH_NOT_FOUND", "message": "Match does not exist" }`.
 * `error` is a stable machine-readable code; `message` is safe to show to users.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus,
    readonly details?: unknown,
  ) {
    super({ error: code, message }, status);
  }
}

export const badRequest = (code: string, message: string, details?: unknown): AppException =>
  new AppException(code, message, HttpStatus.BAD_REQUEST, details);

export const unauthorized = (message = 'Authentication required', code = 'UNAUTHENTICATED'): AppException =>
  new AppException(code, message, HttpStatus.UNAUTHORIZED);

export const forbidden = (message = 'You are not allowed to do this', code = 'FORBIDDEN'): AppException =>
  new AppException(code, message, HttpStatus.FORBIDDEN);

export const notFound = (code: string, message: string): AppException =>
  new AppException(code, message, HttpStatus.NOT_FOUND);

export const conflict = (code: string, message: string, details?: unknown): AppException =>
  new AppException(code, message, HttpStatus.CONFLICT, details);

export const unprocessable = (code: string, message: string, details?: unknown): AppException =>
  new AppException(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);

export const tooManyRequests = (retryAfterSeconds: number): AppException =>
  new AppException('RATE_LIMITED', 'Too many requests, slow down', HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds });

export interface ErrorBody {
  error: string;
  message: string;
  details?: unknown;
  requestId?: string;
}
