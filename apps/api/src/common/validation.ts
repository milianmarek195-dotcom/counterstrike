import { StandardSchemaValidationPipe } from '@nestjs/common';
import { badRequest } from './errors.js';

/**
 * Global validation: Zod schemas attached to @Body/@Query/@Param(`{ schema }`) are enforced here and
 * failures become `VALIDATION_FAILED` with a structured issue list.
 */
export function createValidationPipe(): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({
    exceptionFactory: (issues) =>
      badRequest(
        'VALIDATION_FAILED',
        'The request is not valid',
        issues.map((issue) => ({
          path: (issue.path ?? []).map((segment) =>
            typeof segment === 'object' && segment !== null ? String(segment.key) : String(segment),
          ),
          message: issue.message,
        })),
      ),
  });
}
