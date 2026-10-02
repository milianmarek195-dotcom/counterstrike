import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { InvalidTransitionError } from '@celtist/shared';
import { AppException, type ErrorBody } from './errors.js';

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  429: 'RATE_LIMITED',
};

/**
 * Turns every exception into the standard error body. Unexpected errors become a generic 500: the real
 * error is logged with the request id, never sent to the client (no stack traces, no internals).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const requestId = (request as Request & { id?: string }).id ?? response.getHeader('x-request-id')?.toString();

    let status: number;
    let body: ErrorBody;

    if (exception instanceof AppException) {
      status = exception.getStatus();
      body = { error: exception.code, message: exception.message, details: exception.details };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : typeof (payload as { message?: unknown }).message === 'string'
            ? (payload as { message: string }).message
            : Array.isArray((payload as { message?: unknown }).message)
              ? ((payload as { message: string[] }).message).join('; ')
              : exception.message;
      body = { error: STATUS_CODES[status] ?? 'HTTP_ERROR', message };
    } else if (exception instanceof InvalidTransitionError) {
      status = HttpStatus.CONFLICT;
      body = { error: 'INVALID_STATE_TRANSITION', message: `This is not possible while the ${exception.machine} is ${exception.from}` };
    } else if (isBodyParserError(exception)) {
      status = exception.status;
      body = {
        error: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
        message: status === 413 ? 'Request body is too large' : 'Malformed request body',
      };
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      body = { error: 'INTERNAL_ERROR', message: 'Something went wrong on our side' };
      this.logger.error({ err: exception, requestId, path: request.url }, 'Unhandled exception');
    }

    if (requestId) body.requestId = requestId;
    if (body.details === undefined) delete body.details;
    if (status === HttpStatus.TOO_MANY_REQUESTS && body.details && typeof body.details === 'object') {
      const retry = (body.details as { retryAfterSeconds?: number }).retryAfterSeconds;
      if (retry) response.setHeader('Retry-After', String(retry));
    }
    response.status(status).json(body);
  }
}

function isBodyParserError(error: unknown): error is { status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number' &&
    'type' in error &&
    typeof (error as { type: unknown }).type === 'string'
  );
}
