import { z } from 'zod'

const displayNameSchema = z
  .union([z.string().trim().min(2).max(80), z.literal('')])
  .optional()
  .transform((value) => {
    if (value === '' || value === undefined) return undefined
    return value
  })

export const emailSchema = z.string().trim().toLowerCase().email().max(254)

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')

export const userRoleSchema = z.enum(['user', 'admin'])

export const userSchema = z.object({
  id: z.string(),
  email: emailSchema,
  displayName: z.string().nullable(),
  role: userRoleSchema,
  createdAt: z.string().datetime(),
})

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
})

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
})

export const passwordResetRequestSchema = z.object({
  email: emailSchema,
})

export const passwordResetRequestResponseSchema = z.object({
  accepted: z.literal(true),
})

export const meResponseSchema = z.object({
  user: userSchema,
})

export type UserDto = z.infer<typeof userSchema>
export type UserRole = z.infer<typeof userRoleSchema>
export type RegisterRequest = z.input<typeof registerRequestSchema>
export type RegisterPayload = z.output<typeof registerRequestSchema>
export type LoginRequest = z.infer<typeof loginRequestSchema>
export type PasswordResetRequest = z.infer<typeof passwordResetRequestSchema>
export type PasswordResetRequestResponse = z.infer<typeof passwordResetRequestResponseSchema>
export type MeResponse = z.infer<typeof meResponseSchema>
