import { z } from 'zod'

export const apiErrorCodeSchema = z.enum([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_ERROR',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'AUTH_PASSWORD_RESET_INVALID',
  'INTERNAL_ERROR',
])

const validationErrorDetailSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number()])),
    message: z.string(),
  })
  .strict()

const validationApiErrorSchema = z
  .object({
    code: z.literal('VALIDATION_ERROR'),
    message: z.string(),
    details: z.array(validationErrorDetailSchema).optional(),
  })
  .strict()

const nonValidationApiErrorSchema = z
  .object({
    code: apiErrorCodeSchema.exclude(['VALIDATION_ERROR']),
    message: z.string(),
  })
  .strict()

export const apiErrorSchema = z
  .object({
    error: z.discriminatedUnion('code', [validationApiErrorSchema, nonValidationApiErrorSchema]),
  })
  .strict()

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>
export type ApiErrorResponse = z.infer<typeof apiErrorSchema>
