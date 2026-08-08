// Modified from the Vibe Coding Template (https://github.com/di-sukharev/vibe), Apache-2.0. See NOTICE.
import { z } from 'zod'

const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/

export const displayNameValueSchema = z
  .string()
  .trim()
  .min(2, 'Display name must be at least 2 characters')
  .max(80, 'Display name must be at most 80 characters')
  .refine((value) => !CONTROL_CHAR_PATTERN.test(value), {
    message: 'Display name must not contain control characters',
  })

export const displayNameDtoSchema = displayNameValueSchema.nullable()

const displayNameRegistrationSchema = z
  .union([displayNameValueSchema, z.literal('')])
  .optional()
  .transform((value) => {
    if (value === '' || value === undefined) return undefined
    return value
  })

export const userIdSchema = z.uuid()

export const emailSchema = z.string().trim().toLowerCase().email().max(254)

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')

const loginPasswordSchema = z
  .string()
  .min(1, 'Password is required')
  .max(256, 'Password must be at most 256 characters')

export const userRoleSchema = z.enum(['user', 'admin'])

export const userSchema = z
  .object({
    id: userIdSchema,
    email: emailSchema,
    displayName: displayNameDtoSchema,
    role: userRoleSchema,
    createdAt: z.string().datetime(),
  })
  .strict()

export const registerRequestSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: displayNameRegistrationSchema,
  })
  .strict()

export const loginRequestSchema = z
  .object({
    email: emailSchema,
    password: loginPasswordSchema,
  })
  .strict()

export const passwordResetRequestSchema = z
  .object({
    email: emailSchema,
  })
  .strict()

export const passwordResetRequestResponseSchema = z
  .object({
    accepted: z.literal(true),
  })
  .strict()

export const meResponseSchema = z
  .object({
    user: userSchema,
  })
  .strict()

export type UserDto = z.infer<typeof userSchema>
export type UserRole = z.infer<typeof userRoleSchema>
export type RegisterRequest = z.input<typeof registerRequestSchema>
export type RegisterPayload = z.output<typeof registerRequestSchema>
export type LoginRequest = z.infer<typeof loginRequestSchema>
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>
export type PasswordResetRequestResponse = z.infer<typeof passwordResetRequestResponseSchema>
export type MeResponse = z.infer<typeof meResponseSchema>
